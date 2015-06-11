define('sax',["exports", "module"], function (exports, module) {
  "use strict";

  var sax = {
    parser: function parser(strict, opt) {
      return new SAXParser(strict, opt);
    },
    SAXParser: SAXParser,
    SAXStream: SAXStream,
    createStream: createStream };

  sax.VOID_ELEMENTS = {
    area: 1,
    base: 1,
    br: 1,
    col: 1,
    embed: 1,
    hr: 1,
    img: 1,
    input: 1,
    keygen: 1,
    link: 1,
    meta: 1,
    param: 1,
    source: 1,
    track: 1,
    wbr: 1
  };

  // When we pass the MAX_BUFFER_LENGTH position, start checking for buffer overruns.
  // When we check, schedule the next check for MAX_BUFFER_LENGTH - (max(buffer lengths)),
  // since that's the earliest that a buffer overrun could occur.  This way, checks are
  // as rare as required, but as often as necessary to ensure never crossing this bound.
  // Furthermore, buffers are only tested at most once per write(), so passing a very
  // large string into write() might have undesirable effects, but this is manageable by
  // the caller, so it is assumed to be safe.  Thus, a call to write() may, in the extreme
  // edge case, result in creating at most one complete copy of the string passed in.
  // Set to Infinity to have unlimited buffers.
  sax.MAX_BUFFER_LENGTH = 64 * 1024;

  var buffers = ["comment", "sgmlDecl", "textNode", "tagName", "doctype", "procInstName", "procInstBody", "entity", "attribName", "attribValue", "cdata", "script"];

  sax.EVENTS = // for discoverability.
  ["text", "processinginstruction", "sgmldeclaration", "doctype", "comment", "attribute", "opentag", "closetag", "opencdata", "cdata", "closecdata", "error", "end", "ready", "script", "opennamespace", "closenamespace"];

  function SAXParser(strict, opt) {
    if (!(this instanceof SAXParser)) return new SAXParser(strict, opt);

    var parser = this;
    clearBuffers(parser);
    parser.q = parser.c = "";
    parser.bufferCheckPosition = sax.MAX_BUFFER_LENGTH;
    parser.opt = opt || {};
    parser.opt.lowercase = parser.opt.lowercase || parser.opt.lowercasetags;
    parser.looseCase = parser.opt.lowercase ? "toLowerCase" : "toUpperCase";
    parser.tags = [];
    parser.closed = parser.closedRoot = parser.sawRoot = false;
    parser.tag = parser.error = null;
    parser.strict = !!strict;
    parser.noscript = !!(strict || parser.opt.noscript);
    parser.state = S.BEGIN;
    parser.strictEntities = parser.opt.strictEntities;
    parser.ENTITIES = parser.strictEntities ? Object.create(sax.XML_ENTITIES) : Object.create(sax.ENTITIES);
    parser.attribList = [];

    // namespaces form a prototype chain.
    // it always points at the current tag,
    // which protos to its parent tag.
    if (parser.opt.xmlns) parser.ns = Object.create(rootNS);

    // mostly just for error reporting
    parser.trackPosition = parser.opt.position !== false;
    if (parser.trackPosition) {
      parser.position = parser.line = parser.column = 0;
    }
    emit(parser, "onready");
  }

  if (!Object.create) Object.create = function (o) {
    function f() {
      this.__proto__ = o;
    }
    f.prototype = o;
    return new f();
  };

  if (!Object.getPrototypeOf) Object.getPrototypeOf = function (o) {
    return o.__proto__;
  };

  if (!Object.keys) Object.keys = function (o) {
    var a = [];
    for (var i in o) if (o.hasOwnProperty(i)) a.push(i);
    return a;
  };

  function checkBufferLength(parser) {
    var maxAllowed = Math.max(sax.MAX_BUFFER_LENGTH, 10),
        maxActual = 0;
    for (var i = 0, l = buffers.length; i < l; i++) {
      var len = parser[buffers[i]].length;
      if (len > maxAllowed) {
        // Text/cdata nodes can get big, and since they're buffered,
        // we can get here under normal conditions.
        // Avoid issues by emitting the text node now,
        // so at least it won't get any bigger.
        switch (buffers[i]) {
          case "textNode":
            closeText(parser);
            break;

          case "cdata":
            emitNode(parser, "oncdata", parser.cdata);
            parser.cdata = "";
            break;

          case "script":
            emitNode(parser, "onscript", parser.script);
            parser.script = "";
            break;

          default:
            error(parser, "Max buffer length exceeded: " + buffers[i]);
        }
      }
      maxActual = Math.max(maxActual, len);
    }
    // schedule the next check for the earliest possible buffer overrun.
    parser.bufferCheckPosition = sax.MAX_BUFFER_LENGTH - maxActual + parser.position;
  }

  function clearBuffers(parser) {
    for (var i = 0, l = buffers.length; i < l; i++) {
      parser[buffers[i]] = "";
    }
  }

  function flushBuffers(parser) {
    closeText(parser);
    if (parser.cdata !== "") {
      emitNode(parser, "oncdata", parser.cdata);
      parser.cdata = "";
    }
    if (parser.script !== "") {
      emitNode(parser, "onscript", parser.script);
      parser.script = "";
    }
  }

  SAXParser.prototype = { end: function end() {
      _end(this);
    },
    write: write,
    resume: function resume() {
      this.error = null;return this;
    },
    close: function close() {
      return this.write(null);
    },
    flush: function flush() {
      flushBuffers(this);
    }
  };

  try {
    var Stream = require("stream").Stream;
  } catch (ex) {
    var Stream = function Stream() {};
  }

  var streamWraps = sax.EVENTS.filter(function (ev) {
    return ev !== "error" && ev !== "end";
  });

  function createStream(strict, opt) {
    return new SAXStream(strict, opt);
  }

  function SAXStream(strict, opt) {
    if (!(this instanceof SAXStream)) return new SAXStream(strict, opt);

    Stream.apply(this);

    this._parser = new SAXParser(strict, opt);
    this.writable = true;
    this.readable = true;

    var me = this;

    this._parser.onend = function () {
      me.emit("end");
    };

    this._parser.onerror = function (er) {
      me.emit("error", er);

      // if didn't throw, then means error was handled.
      // go ahead and clear error, so we can write again.
      me._parser.error = null;
    };

    this._decoder = null;

    streamWraps.forEach(function (ev) {
      Object.defineProperty(me, "on" + ev, {
        get: function get() {
          return me._parser["on" + ev];
        },
        set: function set(h) {
          if (!h) {
            me.removeAllListeners(ev);
            return me._parser["on" + ev] = h;
          }
          me.on(ev, h);
        },
        enumerable: true,
        configurable: false
      });
    });
  }

  SAXStream.prototype = Object.create(Stream.prototype, { constructor: { value: SAXStream } });

  SAXStream.prototype.write = function (data) {
    if (typeof Buffer === "function" && typeof Buffer.isBuffer === "function" && Buffer.isBuffer(data)) {
      if (!this._decoder) {
        var SD = require("string_decoder").StringDecoder;
        this._decoder = new SD("utf8");
      }
      data = this._decoder.write(data);
    }

    this._parser.write(data.toString());
    this.emit("data", data);
    return true;
  };

  SAXStream.prototype.end = function (chunk) {
    if (chunk && chunk.length) this.write(chunk);
    this._parser.end();
    return true;
  };

  SAXStream.prototype.on = function (ev, handler) {
    var me = this;
    if (!me._parser["on" + ev] && streamWraps.indexOf(ev) !== -1) {
      me._parser["on" + ev] = function () {
        var args = arguments.length === 1 ? [arguments[0]] : Array.apply(null, arguments);
        args.splice(0, 0, ev);
        me.emit.apply(me, args);
      };
    }

    return Stream.prototype.on.call(me, ev, handler);
  };

  // character classes and tokens
  var whitespace = "\r\n\t "
  // this really needs to be replaced with character classes.
  // XML allows all manner of ridiculous numbers and digits.
  ,
      number = "0124356789",
      letter = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ"
  // (Letter | "_" | ":")
  ,
      quote = "'\"",
      entity = number + letter + "#",
      attribEnd = whitespace + ">",
      CDATA = "[CDATA[",
      DOCTYPE = "DOCTYPE",
      XML_NAMESPACE = "http://www.w3.org/XML/1998/namespace",
      XMLNS_NAMESPACE = "http://www.w3.org/2000/xmlns/",
      rootNS = { xml: XML_NAMESPACE, xmlns: XMLNS_NAMESPACE };

  // turn all the string character sets into character class objects.
  whitespace = charClass(whitespace);
  number = charClass(number);
  letter = charClass(letter);

  // http://www.w3.org/TR/REC-xml/#NT-NameStartChar
  // This implementation works on strings, a single character at a time
  // as such, it cannot ever support astral-plane characters (10000-EFFFF)
  // without a significant breaking change to either this  parser, or the
  // JavaScript language.  Implementation of an emoji-capable xml parser
  // is left as an exercise for the reader.
  var nameStart = /[:_A-Za-z\u00C0-\u00D6\u00D8-\u00F6\u00F8-\u02FF\u0370-\u037D\u037F-\u1FFF\u200C-\u200D\u2070-\u218F\u2C00-\u2FEF\u3001-\uD7FF\uF900-\uFDCF\uFDF0-\uFFFD]/;

  var nameBody = /[:_A-Za-z\u00C0-\u00D6\u00D8-\u00F6\u00F8-\u02FF\u0370-\u037D\u037F-\u1FFF\u200C-\u200D\u2070-\u218F\u2C00-\u2FEF\u3001-\uD7FF\uF900-\uFDCF\uFDF0-\uFFFD\u00B7\u0300-\u036F\u203F-\u2040\.\d-]/;

  quote = charClass(quote);
  entity = charClass(entity);
  attribEnd = charClass(attribEnd);

  function charClass(str) {
    return str.split("").reduce(function (s, c) {
      s[c] = true;
      return s;
    }, {});
  }

  function isRegExp(c) {
    return Object.prototype.toString.call(c) === "[object RegExp]";
  }

  function is(charclass, c) {
    return isRegExp(charclass) ? !!c.match(charclass) : charclass[c];
  }

  function not(charclass, c) {
    return !is(charclass, c);
  }

  var S = 0;
  sax.STATE = { BEGIN: S++ // leading byte order mark or whitespace
    , BEGIN_WHITESPACE: S++ // leading whitespace
    , TEXT: S++ // general stuff
    , TEXT_ENTITY: S++ // &amp and such.
    , OPEN_WAKA: S++ // <
    , SGML_DECL: S++ // <!BLARG
    , SGML_DECL_QUOTED: S++ // <!BLARG foo "bar
    , DOCTYPE: S++ // <!DOCTYPE
    , DOCTYPE_QUOTED: S++ // <!DOCTYPE "//blah
    , DOCTYPE_DTD: S++ // <!DOCTYPE "//blah" [ ...
    , DOCTYPE_DTD_QUOTED: S++ // <!DOCTYPE "//blah" [ "foo
    , COMMENT_STARTING: S++ // <!-
    , COMMENT: S++ // <!--
    , COMMENT_ENDING: S++ // <!-- blah -
    , COMMENT_ENDED: S++ // <!-- blah --
    , CDATA: S++ // <![CDATA[ something
    , CDATA_ENDING: S++ // ]
    , CDATA_ENDING_2: S++ // ]]
    , PROC_INST: S++ // <?hi
    , PROC_INST_BODY: S++ // <?hi there
    , PROC_INST_ENDING: S++ // <?hi "there" ?
    , OPEN_TAG: S++ // <strong
    , OPEN_TAG_SLASH: S++ // <strong /
    , ATTRIB: S++ // <a
    , ATTRIB_NAME: S++ // <a foo
    , ATTRIB_NAME_SAW_WHITE: S++ // <a foo _
    , ATTRIB_VALUE: S++ // <a foo=
    , ATTRIB_VALUE_QUOTED: S++ // <a foo="bar
    , ATTRIB_VALUE_CLOSED: S++ // <a foo="bar"
    , ATTRIB_VALUE_UNQUOTED: S++ // <a foo=bar
    , ATTRIB_VALUE_ENTITY_Q: S++ // <foo bar="&quot;"
    , ATTRIB_VALUE_ENTITY_U: S++ // <foo bar=&quot;
    , CLOSE_TAG: S++ // </a
    , CLOSE_TAG_SAW_WHITE: S++ // </a   >
    , SCRIPT: S++ // <script> ...
    , SCRIPT_ENDING: S++ // <script> ... <
  };

  sax.XML_ENTITIES = { "amp": "&",
    "gt": ">",
    "lt": "<",
    "quot": "\"",
    "apos": "'"
  };

  sax.ENTITIES = { "amp": "&",
    "gt": ">",
    "lt": "<",
    "quot": "\"",
    "apos": "'",
    "AElig": 198,
    "Aacute": 193,
    "Acirc": 194,
    "Agrave": 192,
    "Aring": 197,
    "Atilde": 195,
    "Auml": 196,
    "Ccedil": 199,
    "ETH": 208,
    "Eacute": 201,
    "Ecirc": 202,
    "Egrave": 200,
    "Euml": 203,
    "Iacute": 205,
    "Icirc": 206,
    "Igrave": 204,
    "Iuml": 207,
    "Ntilde": 209,
    "Oacute": 211,
    "Ocirc": 212,
    "Ograve": 210,
    "Oslash": 216,
    "Otilde": 213,
    "Ouml": 214,
    "THORN": 222,
    "Uacute": 218,
    "Ucirc": 219,
    "Ugrave": 217,
    "Uuml": 220,
    "Yacute": 221,
    "aacute": 225,
    "acirc": 226,
    "aelig": 230,
    "agrave": 224,
    "aring": 229,
    "atilde": 227,
    "auml": 228,
    "ccedil": 231,
    "eacute": 233,
    "ecirc": 234,
    "egrave": 232,
    "eth": 240,
    "euml": 235,
    "iacute": 237,
    "icirc": 238,
    "igrave": 236,
    "iuml": 239,
    "ntilde": 241,
    "oacute": 243,
    "ocirc": 244,
    "ograve": 242,
    "oslash": 248,
    "otilde": 245,
    "ouml": 246,
    "szlig": 223,
    "thorn": 254,
    "uacute": 250,
    "ucirc": 251,
    "ugrave": 249,
    "uuml": 252,
    "yacute": 253,
    "yuml": 255,
    "copy": 169,
    "reg": 174,
    "nbsp": 160,
    "iexcl": 161,
    "cent": 162,
    "pound": 163,
    "curren": 164,
    "yen": 165,
    "brvbar": 166,
    "sect": 167,
    "uml": 168,
    "ordf": 170,
    "laquo": 171,
    "not": 172,
    "shy": 173,
    "macr": 175,
    "deg": 176,
    "plusmn": 177,
    "sup1": 185,
    "sup2": 178,
    "sup3": 179,
    "acute": 180,
    "micro": 181,
    "para": 182,
    "middot": 183,
    "cedil": 184,
    "ordm": 186,
    "raquo": 187,
    "frac14": 188,
    "frac12": 189,
    "frac34": 190,
    "iquest": 191,
    "times": 215,
    "divide": 247,
    "OElig": 338,
    "oelig": 339,
    "Scaron": 352,
    "scaron": 353,
    "Yuml": 376,
    "fnof": 402,
    "circ": 710,
    "tilde": 732,
    "Alpha": 913,
    "Beta": 914,
    "Gamma": 915,
    "Delta": 916,
    "Epsilon": 917,
    "Zeta": 918,
    "Eta": 919,
    "Theta": 920,
    "Iota": 921,
    "Kappa": 922,
    "Lambda": 923,
    "Mu": 924,
    "Nu": 925,
    "Xi": 926,
    "Omicron": 927,
    "Pi": 928,
    "Rho": 929,
    "Sigma": 931,
    "Tau": 932,
    "Upsilon": 933,
    "Phi": 934,
    "Chi": 935,
    "Psi": 936,
    "Omega": 937,
    "alpha": 945,
    "beta": 946,
    "gamma": 947,
    "delta": 948,
    "epsilon": 949,
    "zeta": 950,
    "eta": 951,
    "theta": 952,
    "iota": 953,
    "kappa": 954,
    "lambda": 955,
    "mu": 956,
    "nu": 957,
    "xi": 958,
    "omicron": 959,
    "pi": 960,
    "rho": 961,
    "sigmaf": 962,
    "sigma": 963,
    "tau": 964,
    "upsilon": 965,
    "phi": 966,
    "chi": 967,
    "psi": 968,
    "omega": 969,
    "thetasym": 977,
    "upsih": 978,
    "piv": 982,
    "ensp": 8194,
    "emsp": 8195,
    "thinsp": 8201,
    "zwnj": 8204,
    "zwj": 8205,
    "lrm": 8206,
    "rlm": 8207,
    "ndash": 8211,
    "mdash": 8212,
    "lsquo": 8216,
    "rsquo": 8217,
    "sbquo": 8218,
    "ldquo": 8220,
    "rdquo": 8221,
    "bdquo": 8222,
    "dagger": 8224,
    "Dagger": 8225,
    "bull": 8226,
    "hellip": 8230,
    "permil": 8240,
    "prime": 8242,
    "Prime": 8243,
    "lsaquo": 8249,
    "rsaquo": 8250,
    "oline": 8254,
    "frasl": 8260,
    "euro": 8364,
    "image": 8465,
    "weierp": 8472,
    "real": 8476,
    "trade": 8482,
    "alefsym": 8501,
    "larr": 8592,
    "uarr": 8593,
    "rarr": 8594,
    "darr": 8595,
    "harr": 8596,
    "crarr": 8629,
    "lArr": 8656,
    "uArr": 8657,
    "rArr": 8658,
    "dArr": 8659,
    "hArr": 8660,
    "forall": 8704,
    "part": 8706,
    "exist": 8707,
    "empty": 8709,
    "nabla": 8711,
    "isin": 8712,
    "notin": 8713,
    "ni": 8715,
    "prod": 8719,
    "sum": 8721,
    "minus": 8722,
    "lowast": 8727,
    "radic": 8730,
    "prop": 8733,
    "infin": 8734,
    "ang": 8736,
    "and": 8743,
    "or": 8744,
    "cap": 8745,
    "cup": 8746,
    "int": 8747,
    "there4": 8756,
    "sim": 8764,
    "cong": 8773,
    "asymp": 8776,
    "ne": 8800,
    "equiv": 8801,
    "le": 8804,
    "ge": 8805,
    "sub": 8834,
    "sup": 8835,
    "nsub": 8836,
    "sube": 8838,
    "supe": 8839,
    "oplus": 8853,
    "otimes": 8855,
    "perp": 8869,
    "sdot": 8901,
    "lceil": 8968,
    "rceil": 8969,
    "lfloor": 8970,
    "rfloor": 8971,
    "lang": 9001,
    "rang": 9002,
    "loz": 9674,
    "spades": 9824,
    "clubs": 9827,
    "hearts": 9829,
    "diams": 9830
  };

  Object.keys(sax.ENTITIES).forEach(function (key) {
    var e = sax.ENTITIES[key];
    var s = typeof e === "number" ? String.fromCharCode(e) : e;
    sax.ENTITIES[key] = s;
  });

  for (var S in sax.STATE) sax.STATE[sax.STATE[S]] = S;

  // shorthand
  S = sax.STATE;

  function emit(parser, event, data) {
    parser[event] && parser[event](data);
  }

  function emitNode(parser, nodeType, data) {
    if (parser.textNode) closeText(parser);
    emit(parser, nodeType, data);
  }

  function closeText(parser) {
    parser.textNode = textopts(parser.opt, parser.textNode);
    if (parser.textNode) emit(parser, "ontext", parser.textNode);
    parser.textNode = "";
  }

  function textopts(opt, text) {
    if (opt.trim) text = text.trim();
    if (opt.normalize) text = text.replace(/\s+/g, " ");
    return text;
  }

  function error(parser, er) {
    closeText(parser);
    if (parser.trackPosition) {
      er += "\nLine: " + parser.line + "\nColumn: " + parser.column + "\nChar: " + parser.c;
    }
    er = new Error(er);
    parser.error = er;
    emit(parser, "onerror", er);
    return parser;
  }

  function _end(parser) {
    if (parser.sawRoot && !parser.closedRoot) strictFail(parser, "Unclosed root tag");
    if (parser.state !== S.BEGIN && parser.state !== S.BEGIN_WHITESPACE && parser.state !== S.TEXT) error(parser, "Unexpected end");
    closeText(parser);
    parser.c = "";
    parser.closed = true;
    emit(parser, "onend");
    SAXParser.call(parser, parser.strict, parser.opt);
    return parser;
  }

  function strictFail(parser, message) {
    if (typeof parser !== "object" || !(parser instanceof SAXParser)) throw new Error("bad call to strictFail");
    if (parser.strict) error(parser, message);
  }

  function newTag(parser) {
    if (!parser.strict) parser.tagName = parser.tagName[parser.looseCase]();
    var parent = parser.tags[parser.tags.length - 1] || parser,
        tag = parser.tag = { name: parser.tagName, attributes: {} };

    // will be overridden if tag contails an xmlns="foo" or xmlns:foo="bar"
    if (parser.opt.xmlns) tag.ns = parent.ns;
    parser.attribList.length = 0;
  }

  function qname(name, attribute) {
    var i = name.indexOf(":"),
        qualName = i < 0 ? ["", name] : name.split(":"),
        prefix = qualName[0],
        local = qualName[1];

    // <x "xmlns"="http://foo">
    if (attribute && name === "xmlns") {
      prefix = "xmlns";
      local = "";
    }

    return { prefix: prefix, local: local };
  }

  function attrib(parser) {
    if (!parser.strict) parser.attribName = parser.attribName[parser.looseCase]();

    if (parser.attribList.indexOf(parser.attribName) !== -1 || parser.tag.attributes.hasOwnProperty(parser.attribName)) {
      return parser.attribName = parser.attribValue = "";
    }

    if (parser.opt.xmlns) {
      var qn = qname(parser.attribName, true),
          prefix = qn.prefix,
          local = qn.local;

      if (prefix === "xmlns") {
        // namespace binding attribute; push the binding into scope
        if (local === "xml" && parser.attribValue !== XML_NAMESPACE) {
          strictFail(parser, "xml: prefix must be bound to " + XML_NAMESPACE + "\n" + "Actual: " + parser.attribValue);
        } else if (local === "xmlns" && parser.attribValue !== XMLNS_NAMESPACE) {
          strictFail(parser, "xmlns: prefix must be bound to " + XMLNS_NAMESPACE + "\n" + "Actual: " + parser.attribValue);
        } else {
          var tag = parser.tag,
              parent = parser.tags[parser.tags.length - 1] || parser;
          if (tag.ns === parent.ns) {
            tag.ns = Object.create(parent.ns);
          }
          tag.ns[local] = parser.attribValue;
        }
      }

      // defer onattribute events until all attributes have been seen
      // so any new bindings can take effect; preserve attribute order
      // so deferred events can be emitted in document order
      parser.attribList.push([parser.attribName, parser.attribValue]);
    } else {
      // in non-xmlns mode, we can emit the event right away
      parser.tag.attributes[parser.attribName] = parser.attribValue;
      emitNode(parser, "onattribute", { name: parser.attribName,
        value: parser.attribValue });
    }

    parser.attribName = parser.attribValue = "";
  }

  function openTag(parser, selfClosing) {
    if (parser.opt.xmlns) {
      // emit namespace binding events
      var tag = parser.tag;

      // add namespace info to tag
      var qn = qname(parser.tagName);
      tag.prefix = qn.prefix;
      tag.local = qn.local;
      tag.uri = tag.ns[qn.prefix] || "";

      if (tag.prefix && !tag.uri) {
        strictFail(parser, "Unbound namespace prefix: " + JSON.stringify(parser.tagName));
        tag.uri = qn.prefix;
      }

      var parent = parser.tags[parser.tags.length - 1] || parser;
      if (tag.ns && parent.ns !== tag.ns) {
        Object.keys(tag.ns).forEach(function (p) {
          emitNode(parser, "onopennamespace", { prefix: p, uri: tag.ns[p] });
        });
      }

      // handle deferred onattribute events
      // Note: do not apply default ns to attributes:
      //   http://www.w3.org/TR/REC-xml-names/#defaulting
      for (var i = 0, l = parser.attribList.length; i < l; i++) {
        var nv = parser.attribList[i];
        var name = nv[0],
            value = nv[1],
            qualName = qname(name, true),
            prefix = qualName.prefix,
            local = qualName.local,
            uri = prefix == "" ? "" : tag.ns[prefix] || "",
            a = { name: name,
          value: value,
          prefix: prefix,
          local: local,
          uri: uri
        };

        // if there's any attributes with an undefined namespace,
        // then fail on them now.
        if (prefix && prefix != "xmlns" && !uri) {
          strictFail(parser, "Unbound namespace prefix: " + JSON.stringify(prefix));
          a.uri = prefix;
        }
        parser.tag.attributes[name] = a;
        emitNode(parser, "onattribute", a);
      }
      parser.attribList.length = 0;
    }

    parser.tag.isSelfClosing = !!selfClosing;

    // process the tag
    parser.sawRoot = true;
    parser.tags.push(parser.tag);
    emitNode(parser, "onopentag", parser.tag);
    if (!selfClosing) {
      // special case for <script> in non-strict mode.
      if (!parser.noscript && parser.tagName.toLowerCase() === "script") {
        parser.state = S.SCRIPT;
      } else {
        parser.state = S.TEXT;
      }
      parser.tag = null;
      parser.tagName = "";
    }
    parser.attribName = parser.attribValue = "";
    parser.attribList.length = 0;
  }

  function closeTag(parser) {
    if (!parser.tagName) {
      strictFail(parser, "Weird empty close tag.");
      parser.textNode += "</>";
      parser.state = S.TEXT;
      return;
    }

    if (parser.script) {
      if (parser.tagName !== "script") {
        parser.script += "</" + parser.tagName + ">";
        parser.tagName = "";
        parser.state = S.SCRIPT;
        return;
      }
      emitNode(parser, "onscript", parser.script);
      parser.script = "";
    }

    // first make sure that the closing tag actually exists.
    // <a><b></c></b></a> will close everything, otherwise.
    var t = parser.tags.length;
    var tagName = parser.tagName;
    if (!parser.strict) tagName = tagName[parser.looseCase]();
    var closeTo = tagName;
    while (t--) {
      var close = parser.tags[t];
      if (close.name !== closeTo) {
        // fail the first time in strict mode
        strictFail(parser, "Unexpected close tag");
      } else break;
    }

    // didn't find it.  we already failed for strict, so just abort.
    if (t < 0) {
      strictFail(parser, "Unmatched closing tag: " + parser.tagName);
      parser.textNode += "</" + parser.tagName + ">";
      parser.state = S.TEXT;
      return;
    }
    parser.tagName = tagName;
    var s = parser.tags.length;
    while (s-- > t) {
      var tag = parser.tag = parser.tags.pop();
      parser.tagName = parser.tag.name;
      emitNode(parser, "onclosetag", parser.tagName);

      var x = {};
      for (var i in tag.ns) x[i] = tag.ns[i];

      var parent = parser.tags[parser.tags.length - 1] || parser;
      if (parser.opt.xmlns && tag.ns !== parent.ns) {
        // remove namespace bindings introduced by tag
        Object.keys(tag.ns).forEach(function (p) {
          var n = tag.ns[p];
          emitNode(parser, "onclosenamespace", { prefix: p, uri: n });
        });
      }
    }
    if (t === 0) parser.closedRoot = true;
    parser.tagName = parser.attribValue = parser.attribName = "";
    parser.attribList.length = 0;
    parser.state = S.TEXT;
  }

  function parseEntity(parser) {
    var entity = parser.entity,
        entityLC = entity.toLowerCase(),
        num,
        numStr = "";
    if (parser.ENTITIES[entity]) return parser.ENTITIES[entity];
    if (parser.ENTITIES[entityLC]) return parser.ENTITIES[entityLC];
    entity = entityLC;
    if (entity.charAt(0) === "#") {
      if (entity.charAt(1) === "x") {
        entity = entity.slice(2);
        num = parseInt(entity, 16);
        numStr = num.toString(16);
      } else {
        entity = entity.slice(1);
        num = parseInt(entity, 10);
        numStr = num.toString(10);
      }
    }
    entity = entity.replace(/^0+/, "");
    if (numStr.toLowerCase() !== entity) {
      strictFail(parser, "Invalid character entity");
      return "&" + parser.entity + ";";
    }

    return String.fromCodePoint(num);
  }

  function write(chunk) {
    var parser = this;
    if (this.error) throw this.error;
    if (parser.closed) return error(parser, "Cannot write after close. Assign an onready handler.");
    if (chunk === null) return _end(parser);
    var i = 0,
        c = "";
    while (parser.c = c = chunk.charAt(i++)) {
      if (parser.trackPosition) {
        parser.position++;
        if (c === "\n") {
          parser.line++;
          parser.column = 0;
        } else parser.column++;
      }
      switch (parser.state) {

        case S.BEGIN:
          parser.state = S.BEGIN_WHITESPACE;
          if (c === "﻿") {
            continue;
          }
        // no continue - fall through

        case S.BEGIN_WHITESPACE:
          if (c === "<") {
            parser.state = S.OPEN_WAKA;
            parser.startTagPosition = parser.position;
          } else if (not(whitespace, c)) {
            // have to process this as a text node.
            // weird, but happens.
            strictFail(parser, "Non-whitespace before first tag.");
            parser.textNode = c;
            parser.state = S.TEXT;
          }
          continue;

        case S.TEXT:
          if (parser.sawRoot && !parser.closedRoot) {
            var starti = i - 1;
            while (c && c !== "<" && c !== "&") {
              c = chunk.charAt(i++);
              if (c && parser.trackPosition) {
                parser.position++;
                if (c === "\n") {
                  parser.line++;
                  parser.column = 0;
                } else parser.column++;
              }
            }
            parser.textNode += chunk.substring(starti, i - 1);
          }
          if (c === "<" && !(parser.sawRoot && parser.closedRoot && !parser.strict)) {
            parser.state = S.OPEN_WAKA;
            parser.startTagPosition = parser.position;
          } else {
            if (not(whitespace, c) && (!parser.sawRoot || parser.closedRoot)) strictFail(parser, "Text data outside of root node.");
            if (c === "&") parser.state = S.TEXT_ENTITY;else parser.textNode += c;
          }
          continue;

        case S.SCRIPT:
          // only non-strict
          if (c === "<") {
            parser.state = S.SCRIPT_ENDING;
          } else parser.script += c;
          continue;

        case S.SCRIPT_ENDING:
          if (c === "/") {
            parser.state = S.CLOSE_TAG;
          } else {
            parser.script += "<" + c;
            parser.state = S.SCRIPT;
          }
          continue;

        case S.OPEN_WAKA:
          // either a /, ?, !, or text is coming next.
          if (c === "!") {
            parser.state = S.SGML_DECL;
            parser.sgmlDecl = "";
          } else if (is(whitespace, c)) {} else if (is(nameStart, c)) {
            parser.state = S.OPEN_TAG;
            parser.tagName = c;
          } else if (c === "/") {
            parser.state = S.CLOSE_TAG;
            parser.tagName = "";
          } else if (c === "?") {
            parser.state = S.PROC_INST;
            parser.procInstName = parser.procInstBody = "";
          } else {
            strictFail(parser, "Unencoded <");
            // if there was some whitespace, then add that in.
            if (parser.startTagPosition + 1 < parser.position) {
              var pad = parser.position - parser.startTagPosition;
              c = new Array(pad).join(" ") + c;
            }
            parser.textNode += "<" + c;
            parser.state = S.TEXT;
          }
          continue;

        case S.SGML_DECL:
          if ((parser.sgmlDecl + c).toUpperCase() === CDATA) {
            emitNode(parser, "onopencdata");
            parser.state = S.CDATA;
            parser.sgmlDecl = "";
            parser.cdata = "";
          } else if (parser.sgmlDecl + c === "--") {
            parser.state = S.COMMENT;
            parser.comment = "";
            parser.sgmlDecl = "";
          } else if ((parser.sgmlDecl + c).toUpperCase() === DOCTYPE) {
            parser.state = S.DOCTYPE;
            if (parser.doctype || parser.sawRoot) strictFail(parser, "Inappropriately located doctype declaration");
            parser.doctype = "";
            parser.sgmlDecl = "";
          } else if (c === ">") {
            emitNode(parser, "onsgmldeclaration", parser.sgmlDecl);
            parser.sgmlDecl = "";
            parser.state = S.TEXT;
          } else if (is(quote, c)) {
            parser.state = S.SGML_DECL_QUOTED;
            parser.sgmlDecl += c;
          } else parser.sgmlDecl += c;
          continue;

        case S.SGML_DECL_QUOTED:
          if (c === parser.q) {
            parser.state = S.SGML_DECL;
            parser.q = "";
          }
          parser.sgmlDecl += c;
          continue;

        case S.DOCTYPE:
          if (c === ">") {
            parser.state = S.TEXT;
            emitNode(parser, "ondoctype", parser.doctype);
            parser.doctype = true // just remember that we saw it.
            ;
          } else {
            parser.doctype += c;
            if (c === "[") parser.state = S.DOCTYPE_DTD;else if (is(quote, c)) {
              parser.state = S.DOCTYPE_QUOTED;
              parser.q = c;
            }
          }
          continue;

        case S.DOCTYPE_QUOTED:
          parser.doctype += c;
          if (c === parser.q) {
            parser.q = "";
            parser.state = S.DOCTYPE;
          }
          continue;

        case S.DOCTYPE_DTD:
          parser.doctype += c;
          if (c === "]") parser.state = S.DOCTYPE;else if (is(quote, c)) {
            parser.state = S.DOCTYPE_DTD_QUOTED;
            parser.q = c;
          }
          continue;

        case S.DOCTYPE_DTD_QUOTED:
          parser.doctype += c;
          if (c === parser.q) {
            parser.state = S.DOCTYPE_DTD;
            parser.q = "";
          }
          continue;

        case S.COMMENT:
          if (c === "-") parser.state = S.COMMENT_ENDING;else parser.comment += c;
          continue;

        case S.COMMENT_ENDING:
          if (c === "-") {
            parser.state = S.COMMENT_ENDED;
            parser.comment = textopts(parser.opt, parser.comment);
            if (parser.comment) emitNode(parser, "oncomment", parser.comment);
            parser.comment = "";
          } else {
            parser.comment += "-" + c;
            parser.state = S.COMMENT;
          }
          continue;

        case S.COMMENT_ENDED:
          if (c !== ">") {
            strictFail(parser, "Malformed comment");
            // allow <!-- blah -- bloo --> in non-strict mode,
            // which is a comment of " blah -- bloo "
            parser.comment += "--" + c;
            parser.state = S.COMMENT;
          } else parser.state = S.TEXT;
          continue;

        case S.CDATA:
          if (c === "]") parser.state = S.CDATA_ENDING;else parser.cdata += c;
          continue;

        case S.CDATA_ENDING:
          if (c === "]") parser.state = S.CDATA_ENDING_2;else {
            parser.cdata += "]" + c;
            parser.state = S.CDATA;
          }
          continue;

        case S.CDATA_ENDING_2:
          if (c === ">") {
            if (parser.cdata) emitNode(parser, "oncdata", parser.cdata);
            emitNode(parser, "onclosecdata");
            parser.cdata = "";
            parser.state = S.TEXT;
          } else if (c === "]") {
            parser.cdata += "]";
          } else {
            parser.cdata += "]]" + c;
            parser.state = S.CDATA;
          }
          continue;

        case S.PROC_INST:
          if (c === "?") parser.state = S.PROC_INST_ENDING;else if (is(whitespace, c)) parser.state = S.PROC_INST_BODY;else parser.procInstName += c;
          continue;

        case S.PROC_INST_BODY:
          if (!parser.procInstBody && is(whitespace, c)) continue;else if (c === "?") parser.state = S.PROC_INST_ENDING;else parser.procInstBody += c;
          continue;

        case S.PROC_INST_ENDING:
          if (c === ">") {
            emitNode(parser, "onprocessinginstruction", {
              name: parser.procInstName,
              body: parser.procInstBody
            });
            parser.procInstName = parser.procInstBody = "";
            parser.state = S.TEXT;
          } else {
            parser.procInstBody += "?" + c;
            parser.state = S.PROC_INST_BODY;
          }
          continue;

        case S.OPEN_TAG:
          if (is(nameBody, c)) parser.tagName += c;else {
            newTag(parser);
            if (c === ">") {
              if (parser.opt.html5 && parser.tagName.toLowerCase() in sax.VOID_ELEMENTS) {
                openTag(parser, true);
                closeTag(parser);
              } else openTag(parser);
            } else if (c === "/") parser.state = S.OPEN_TAG_SLASH;else {
              if (not(whitespace, c)) strictFail(parser, "Invalid character in tag name");
              parser.state = S.ATTRIB;
            }
          }
          continue;

        case S.OPEN_TAG_SLASH:
          if (c === ">") {
            openTag(parser, true);
            closeTag(parser);
          } else {
            strictFail(parser, "Forward-slash in opening tag not followed by >");
            parser.state = S.ATTRIB;
          }
          continue;

        case S.ATTRIB:
          // haven't read the attribute name yet.
          if (is(whitespace, c)) continue;else if (c === ">") openTag(parser);else if (c === "/") parser.state = S.OPEN_TAG_SLASH;else if (is(nameStart, c)) {
            parser.attribName = c;
            parser.attribValue = "";
            parser.state = S.ATTRIB_NAME;
          } else strictFail(parser, "Invalid attribute name");
          continue;

        case S.ATTRIB_NAME:
          if (c === "=") parser.state = S.ATTRIB_VALUE;else if (c === ">") {
            strictFail(parser, "Attribute without value");
            parser.attribValue = parser.attribName;
            attrib(parser);
            openTag(parser);
          } else if (is(whitespace, c)) parser.state = S.ATTRIB_NAME_SAW_WHITE;else if (is(nameBody, c)) parser.attribName += c;else strictFail(parser, "Invalid attribute name");
          continue;

        case S.ATTRIB_NAME_SAW_WHITE:
          if (c === "=") parser.state = S.ATTRIB_VALUE;else if (is(whitespace, c)) continue;else {
            strictFail(parser, "Attribute without value");
            parser.tag.attributes[parser.attribName] = "";
            parser.attribValue = "";
            emitNode(parser, "onattribute", { name: parser.attribName, value: "" });
            parser.attribName = "";
            if (c === ">") openTag(parser);else if (is(nameStart, c)) {
              parser.attribName = c;
              parser.state = S.ATTRIB_NAME;
            } else {
              strictFail(parser, "Invalid attribute name");
              parser.state = S.ATTRIB;
            }
          }
          continue;

        case S.ATTRIB_VALUE:
          if (is(whitespace, c)) continue;else if (is(quote, c)) {
            parser.q = c;
            parser.state = S.ATTRIB_VALUE_QUOTED;
          } else {
            strictFail(parser, "Unquoted attribute value");
            parser.state = S.ATTRIB_VALUE_UNQUOTED;
            parser.attribValue = c;
          }
          continue;

        case S.ATTRIB_VALUE_QUOTED:
          if (c !== parser.q) {
            if (c === "&") parser.state = S.ATTRIB_VALUE_ENTITY_Q;else parser.attribValue += c;
            continue;
          }
          attrib(parser);
          parser.q = "";
          parser.state = S.ATTRIB_VALUE_CLOSED;
          continue;

        case S.ATTRIB_VALUE_CLOSED:
          if (is(whitespace, c)) {
            parser.state = S.ATTRIB;
          } else if (c === ">") openTag(parser);else if (c === "/") parser.state = S.OPEN_TAG_SLASH;else if (is(nameStart, c)) {
            strictFail(parser, "No whitespace between attributes");
            parser.attribName = c;
            parser.attribValue = "";
            parser.state = S.ATTRIB_NAME;
          } else strictFail(parser, "Invalid attribute name");
          continue;

        case S.ATTRIB_VALUE_UNQUOTED:
          if (not(attribEnd, c)) {
            if (c === "&") parser.state = S.ATTRIB_VALUE_ENTITY_U;else parser.attribValue += c;
            continue;
          }
          attrib(parser);
          if (c === ">") openTag(parser);else parser.state = S.ATTRIB;
          continue;

        case S.CLOSE_TAG:
          if (!parser.tagName) {
            if (is(whitespace, c)) continue;else if (not(nameStart, c)) {
              if (parser.script) {
                parser.script += "</" + c;
                parser.state = S.SCRIPT;
              } else {
                strictFail(parser, "Invalid tagname in closing tag.");
              }
            } else parser.tagName = c;
          } else if (c === ">") closeTag(parser);else if (is(nameBody, c)) parser.tagName += c;else if (parser.script) {
            parser.script += "</" + parser.tagName;
            parser.tagName = "";
            parser.state = S.SCRIPT;
          } else {
            if (not(whitespace, c)) strictFail(parser, "Invalid tagname in closing tag");
            parser.state = S.CLOSE_TAG_SAW_WHITE;
          }
          continue;

        case S.CLOSE_TAG_SAW_WHITE:
          if (is(whitespace, c)) continue;
          if (c === ">") closeTag(parser);else strictFail(parser, "Invalid characters in closing tag");
          continue;

        case S.TEXT_ENTITY:
        case S.ATTRIB_VALUE_ENTITY_Q:
        case S.ATTRIB_VALUE_ENTITY_U:
          switch (parser.state) {
            case S.TEXT_ENTITY:
              var returnState = S.TEXT,
                  buffer = "textNode";
              break;

            case S.ATTRIB_VALUE_ENTITY_Q:
              var returnState = S.ATTRIB_VALUE_QUOTED,
                  buffer = "attribValue";
              break;

            case S.ATTRIB_VALUE_ENTITY_U:
              var returnState = S.ATTRIB_VALUE_UNQUOTED,
                  buffer = "attribValue";
              break;
          }
          if (c === ";") {
            parser[buffer] += parseEntity(parser);
            parser.entity = "";
            parser.state = returnState;
          } else if (is(entity, c)) parser.entity += c;else {
            strictFail(parser, "Invalid character entity");
            parser[buffer] += "&" + parser.entity + c;
            parser.entity = "";
            parser.state = returnState;
          }
          continue;

        default:
          throw new Error(parser, "Unknown state: " + parser.state);
      }
    } // while
    // cdata blocks can get very big under normal conditions. emit and move on.
    // if (parser.state === S.CDATA && parser.cdata) {
    //   emitNode(parser, "oncdata", parser.cdata)
    //   parser.cdata = ""
    // }
    if (parser.position >= parser.bufferCheckPosition) checkBufferLength(parser);
    return parser;
  }

  /*! http://mths.be/fromcodepoint v0.1.0 by @mathias */
  if (!String.fromCodePoint) {
    (function () {
      var stringFromCharCode = String.fromCharCode;
      var floor = Math.floor;
      var fromCodePoint = function fromCodePoint() {
        var MAX_SIZE = 16384;
        var codeUnits = [];
        var highSurrogate;
        var lowSurrogate;
        var index = -1;
        var length = arguments.length;
        if (!length) {
          return "";
        }
        var result = "";
        while (++index < length) {
          var codePoint = Number(arguments[index]);
          if (!isFinite(codePoint) || // `NaN`, `+Infinity`, or `-Infinity`
          codePoint < 0 || // not a valid Unicode code point
          codePoint > 1114111 || // not a valid Unicode code point
          floor(codePoint) != codePoint // not an integer
          ) {
            throw RangeError("Invalid code point: " + codePoint);
          }
          if (codePoint <= 65535) {
            // BMP code point
            codeUnits.push(codePoint);
          } else {
            // Astral code point; split in surrogate halves
            // http://mathiasbynens.be/notes/javascript-encoding#surrogate-formulae
            codePoint -= 65536;
            highSurrogate = (codePoint >> 10) + 55296;
            lowSurrogate = codePoint % 1024 + 56320;
            codeUnits.push(highSurrogate, lowSurrogate);
          }
          if (index + 1 == length || codeUnits.length > MAX_SIZE) {
            result += stringFromCharCode.apply(null, codeUnits);
            codeUnits.length = 0;
          }
        }
        return result;
      };
      if (Object.defineProperty) {
        Object.defineProperty(String, "fromCodePoint", {
          "value": fromCodePoint,
          "configurable": true,
          "writable": true
        });
      } else {
        String.fromCodePoint = fromCodePoint;
      }
    })();
  }

  module.exports = sax;
});

// wait for it...
;
define('transformTag',['exports', 'module'], function (exports, module) {
  'use strict';

  var propMap = {
    id: 'id',
    name: 'name',
    'class': 'className',
    title: 'title',
    value: 'value',
    tabindex: 'tabIndex'
  };

  function transformAttributes(attributes) {
    var properties = {};
    properties.attributes = attributes;

    for (var prop in attributes) {
      if (attributes.hasOwnProperty(prop)) {
        if (propMap[prop]) {
          properties[propMap[prop]] = attributes[prop];
          delete attributes[prop];
        }
      }
    }

    return properties;
  }

  function transformTag(tag) {
    tag.properties = tag.svg ? { attributes: tag.attributes } : transformAttributes(tag.attributes);
    delete tag.attributes;
  }

  module.exports = transformTag;
});

define('global/document',[],function() { return document; });

define('is-object',['require','exports','module'],function (require, exports, module) {"use strict";

module.exports = function isObject(x) {
	return typeof x === "object" && x !== null;
};

});

define('virtual-dom/vnode/is-vhook',['require','exports','module'],function (require, exports, module) {module.exports = isHook

function isHook(hook) {
    return hook &&
      (typeof hook.hook === "function" && !hook.hasOwnProperty("hook") ||
       typeof hook.unhook === "function" && !hook.hasOwnProperty("unhook"))
}

});

define('virtual-dom/vdom/apply-properties',['require','exports','module','is-object','../vnode/is-vhook'],function (require, exports, module) {var isObject = require("is-object")
var isHook = require("../vnode/is-vhook")

module.exports = applyProperties

function applyProperties(node, props, previous) {
    for (var propName in props) {
        var propValue = props[propName]

        if (propValue === undefined) {
            removeProperty(node, propName, propValue, previous);
        } else if (isHook(propValue)) {
            removeProperty(node, propName, propValue, previous)
            if (propValue.hook) {
                propValue.hook(node,
                    propName,
                    previous ? previous[propName] : undefined)
            }
        } else {
            if (isObject(propValue)) {
                patchObject(node, props, previous, propName, propValue);
            } else {
                node[propName] = propValue
            }
        }
    }
}

function removeProperty(node, propName, propValue, previous) {
    if (previous) {
        var previousValue = previous[propName]

        if (!isHook(previousValue)) {
            if (propName === "attributes") {
                for (var attrName in previousValue) {
                    node.removeAttribute(attrName)
                }
            } else if (propName === "style") {
                for (var i in previousValue) {
                    node.style[i] = ""
                }
            } else if (typeof previousValue === "string") {
                node[propName] = ""
            } else {
                node[propName] = null
            }
        } else if (previousValue.unhook) {
            previousValue.unhook(node, propName, propValue)
        }
    }
}

function patchObject(node, props, previous, propName, propValue) {
    var previousValue = previous ? previous[propName] : undefined

    // Set attributes
    if (propName === "attributes") {
        for (var attrName in propValue) {
            var attrValue = propValue[attrName]

            if (attrValue === undefined) {
                node.removeAttribute(attrName)
            } else {
                node.setAttribute(attrName, attrValue)
            }
        }

        return
    }

    if(previousValue && isObject(previousValue) &&
        getPrototype(previousValue) !== getPrototype(propValue)) {
        node[propName] = propValue
        return
    }

    if (!isObject(node[propName])) {
        node[propName] = {}
    }

    var replacer = propName === "style" ? "" : undefined

    for (var k in propValue) {
        var value = propValue[k]
        node[propName][k] = (value === undefined) ? replacer : value
    }
}

function getPrototype(value) {
    if (Object.getPrototypeOf) {
        return Object.getPrototypeOf(value)
    } else if (value.__proto__) {
        return value.__proto__
    } else if (value.constructor) {
        return value.constructor.prototype
    }
}

});

define('virtual-dom/vnode/version',['require','exports','module'],function (require, exports, module) {module.exports = "2"

});

define('virtual-dom/vnode/is-vnode',['require','exports','module','./version'],function (require, exports, module) {var version = require("./version")

module.exports = isVirtualNode

function isVirtualNode(x) {
    return x && x.type === "VirtualNode" && x.version === version
}

});

define('virtual-dom/vnode/is-vtext',['require','exports','module','./version'],function (require, exports, module) {var version = require("./version")

module.exports = isVirtualText

function isVirtualText(x) {
    return x && x.type === "VirtualText" && x.version === version
}

});

define('virtual-dom/vnode/is-widget',['require','exports','module'],function (require, exports, module) {module.exports = isWidget

function isWidget(w) {
    return w && w.type === "Widget"
}

});

define('virtual-dom/vnode/is-thunk',['require','exports','module'],function (require, exports, module) {module.exports = isThunk

function isThunk(t) {
    return t && t.type === "Thunk"
}

});

define('virtual-dom/vnode/handle-thunk',['require','exports','module','./is-vnode','./is-vtext','./is-widget','./is-thunk'],function (require, exports, module) {var isVNode = require("./is-vnode")
var isVText = require("./is-vtext")
var isWidget = require("./is-widget")
var isThunk = require("./is-thunk")

module.exports = handleThunk

function handleThunk(a, b) {
    var renderedA = a
    var renderedB = b

    if (isThunk(b)) {
        renderedB = renderThunk(b, a)
    }

    if (isThunk(a)) {
        renderedA = renderThunk(a, null)
    }

    return {
        a: renderedA,
        b: renderedB
    }
}

function renderThunk(thunk, previous) {
    var renderedThunk = thunk.vnode

    if (!renderedThunk) {
        renderedThunk = thunk.vnode = thunk.render(previous)
    }

    if (!(isVNode(renderedThunk) ||
            isVText(renderedThunk) ||
            isWidget(renderedThunk))) {
        throw new Error("thunk did not return a valid node");
    }

    return renderedThunk
}

});

define('virtual-dom/vdom/create-element',['require','exports','module','global/document','./apply-properties','../vnode/is-vnode','../vnode/is-vtext','../vnode/is-widget','../vnode/handle-thunk'],function (require, exports, module) {var document = require("global/document")

var applyProperties = require("./apply-properties")

var isVNode = require("../vnode/is-vnode")
var isVText = require("../vnode/is-vtext")
var isWidget = require("../vnode/is-widget")
var handleThunk = require("../vnode/handle-thunk")

module.exports = createElement

function createElement(vnode, opts) {
    var doc = opts ? opts.document || document : document
    var warn = opts ? opts.warn : null

    vnode = handleThunk(vnode).a

    if (isWidget(vnode)) {
        return vnode.init()
    } else if (isVText(vnode)) {
        return doc.createTextNode(vnode.text)
    } else if (!isVNode(vnode)) {
        if (warn) {
            warn("Item is not a valid virtual dom node", vnode)
        }
        return null
    }

    var node = (vnode.namespace === null) ?
        doc.createElement(vnode.tagName) :
        doc.createElementNS(vnode.namespace, vnode.tagName)

    var props = vnode.properties
    applyProperties(node, props)

    var children = vnode.children

    for (var i = 0; i < children.length; i++) {
        var childNode = createElement(children[i], opts)
        if (childNode) {
            node.appendChild(childNode)
        }
    }

    return node
}

});

define('x-is-array',['require','exports','module'],function (require, exports, module) {var nativeIsArray = Array.isArray
var toString = Object.prototype.toString

module.exports = nativeIsArray || isArray

function isArray(obj) {
    return toString.call(obj) === "[object Array]"
}

});

define('virtual-dom/vdom/dom-index',['require','exports','module'],function (require, exports, module) {// Maps a virtual DOM tree onto a real DOM tree in an efficient manner.
// We don't want to read all of the DOM nodes in the tree so we use
// the in-order tree indexing to eliminate recursion down certain branches.
// We only recurse into a DOM node if we know that it contains a child of
// interest.

var noChild = {}

module.exports = domIndex

function domIndex(rootNode, tree, indices, nodes) {
    if (!indices || indices.length === 0) {
        return {}
    } else {
        indices.sort(ascending)
        return recurse(rootNode, tree, indices, nodes, 0)
    }
}

function recurse(rootNode, tree, indices, nodes, rootIndex) {
    nodes = nodes || {}


    if (rootNode) {
        if (indexInRange(indices, rootIndex, rootIndex)) {
            nodes[rootIndex] = rootNode
        }

        var vChildren = tree.children

        if (vChildren) {

            var childNodes = rootNode.childNodes

            for (var i = 0; i < tree.children.length; i++) {
                rootIndex += 1

                var vChild = vChildren[i] || noChild
                var nextIndex = rootIndex + (vChild.count || 0)

                // skip recursion down the tree if there are no nodes down here
                if (indexInRange(indices, rootIndex, nextIndex)) {
                    recurse(childNodes[i], vChild, indices, nodes, rootIndex)
                }

                rootIndex = nextIndex
            }
        }
    }

    return nodes
}

// Binary search for an index in the interval [left, right]
function indexInRange(indices, left, right) {
    if (indices.length === 0) {
        return false
    }

    var minIndex = 0
    var maxIndex = indices.length - 1
    var currentIndex
    var currentItem

    while (minIndex <= maxIndex) {
        currentIndex = ((maxIndex + minIndex) / 2) >> 0
        currentItem = indices[currentIndex]

        if (minIndex === maxIndex) {
            return currentItem >= left && currentItem <= right
        } else if (currentItem < left) {
            minIndex = currentIndex + 1
        } else  if (currentItem > right) {
            maxIndex = currentIndex - 1
        } else {
            return true
        }
    }

    return false;
}

function ascending(a, b) {
    return a > b ? 1 : -1
}

});

define('virtual-dom/vnode/vpatch',['require','exports','module','./version'],function (require, exports, module) {var version = require("./version")

VirtualPatch.NONE = 0
VirtualPatch.VTEXT = 1
VirtualPatch.VNODE = 2
VirtualPatch.WIDGET = 3
VirtualPatch.PROPS = 4
VirtualPatch.ORDER = 5
VirtualPatch.INSERT = 6
VirtualPatch.REMOVE = 7
VirtualPatch.THUNK = 8

module.exports = VirtualPatch

function VirtualPatch(type, vNode, patch) {
    this.type = Number(type)
    this.vNode = vNode
    this.patch = patch
}

VirtualPatch.prototype.version = version
VirtualPatch.prototype.type = "VirtualPatch"

});

define('virtual-dom/vdom/update-widget',['require','exports','module','../vnode/is-widget'],function (require, exports, module) {var isWidget = require("../vnode/is-widget")

module.exports = updateWidget

function updateWidget(a, b) {
    if (isWidget(a) && isWidget(b)) {
        if ("name" in a && "name" in b) {
            return a.id === b.id
        } else {
            return a.init === b.init
        }
    }

    return false
}

});

define('virtual-dom/vdom/patch-op',['require','exports','module','./apply-properties','../vnode/is-widget','../vnode/vpatch','./create-element','./update-widget'],function (require, exports, module) {var applyProperties = require("./apply-properties")

var isWidget = require("../vnode/is-widget")
var VPatch = require("../vnode/vpatch")

var render = require("./create-element")
var updateWidget = require("./update-widget")

module.exports = applyPatch

function applyPatch(vpatch, domNode, renderOptions) {
    var type = vpatch.type
    var vNode = vpatch.vNode
    var patch = vpatch.patch

    switch (type) {
        case VPatch.REMOVE:
            return removeNode(domNode, vNode)
        case VPatch.INSERT:
            return insertNode(domNode, patch, renderOptions)
        case VPatch.VTEXT:
            return stringPatch(domNode, vNode, patch, renderOptions)
        case VPatch.WIDGET:
            return widgetPatch(domNode, vNode, patch, renderOptions)
        case VPatch.VNODE:
            return vNodePatch(domNode, vNode, patch, renderOptions)
        case VPatch.ORDER:
            reorderChildren(domNode, patch)
            return domNode
        case VPatch.PROPS:
            applyProperties(domNode, patch, vNode.properties)
            return domNode
        case VPatch.THUNK:
            return replaceRoot(domNode,
                renderOptions.patch(domNode, patch, renderOptions))
        default:
            return domNode
    }
}

function removeNode(domNode, vNode) {
    var parentNode = domNode.parentNode

    if (parentNode) {
        parentNode.removeChild(domNode)
    }

    destroyWidget(domNode, vNode);

    return null
}

function insertNode(parentNode, vNode, renderOptions) {
    var newNode = render(vNode, renderOptions)

    if (parentNode) {
        parentNode.appendChild(newNode)
    }

    return parentNode
}

function stringPatch(domNode, leftVNode, vText, renderOptions) {
    var newNode

    if (domNode.nodeType === 3) {
        domNode.replaceData(0, domNode.length, vText.text)
        newNode = domNode
    } else {
        var parentNode = domNode.parentNode
        newNode = render(vText, renderOptions)

        if (parentNode && newNode !== domNode) {
            parentNode.replaceChild(newNode, domNode)
        }
    }

    return newNode
}

function widgetPatch(domNode, leftVNode, widget, renderOptions) {
    var updating = updateWidget(leftVNode, widget)
    var newNode

    if (updating) {
        newNode = widget.update(leftVNode, domNode) || domNode
    } else {
        newNode = render(widget, renderOptions)
    }

    var parentNode = domNode.parentNode

    if (parentNode && newNode !== domNode) {
        parentNode.replaceChild(newNode, domNode)
    }

    if (!updating) {
        destroyWidget(domNode, leftVNode)
    }

    return newNode
}

function vNodePatch(domNode, leftVNode, vNode, renderOptions) {
    var parentNode = domNode.parentNode
    var newNode = render(vNode, renderOptions)

    if (parentNode && newNode !== domNode) {
        parentNode.replaceChild(newNode, domNode)
    }

    return newNode
}

function destroyWidget(domNode, w) {
    if (typeof w.destroy === "function" && isWidget(w)) {
        w.destroy(domNode)
    }
}

function reorderChildren(domNode, moves) {
    var childNodes = domNode.childNodes
    var keyMap = {}
    var node
    var remove
    var insert

    for (var i = 0; i < moves.removes.length; i++) {
        remove = moves.removes[i]
        node = childNodes[remove.from]
        if (remove.key) {
            keyMap[remove.key] = node
        }
        domNode.removeChild(node)
    }

    var length = childNodes.length
    for (var j = 0; j < moves.inserts.length; j++) {
        insert = moves.inserts[j]
        node = keyMap[insert.key]
        // this is the weirdest bug i've ever seen in webkit
        domNode.insertBefore(node, insert.to >= length++ ? null : childNodes[insert.to])
    }
}

function replaceRoot(oldRoot, newRoot) {
    if (oldRoot && newRoot && oldRoot !== newRoot && oldRoot.parentNode) {
        oldRoot.parentNode.replaceChild(newRoot, oldRoot)
    }

    return newRoot;
}

});

define('virtual-dom/vdom/patch',['require','exports','module','global/document','x-is-array','./dom-index','./patch-op'],function (require, exports, module) {var document = require("global/document")
var isArray = require("x-is-array")

var domIndex = require("./dom-index")
var patchOp = require("./patch-op")
module.exports = patch

function patch(rootNode, patches) {
    return patchRecursive(rootNode, patches)
}

function patchRecursive(rootNode, patches, renderOptions) {
    var indices = patchIndices(patches)

    if (indices.length === 0) {
        return rootNode
    }

    var index = domIndex(rootNode, patches.a, indices)
    var ownerDocument = rootNode.ownerDocument

    if (!renderOptions) {
        renderOptions = { patch: patchRecursive }
        if (ownerDocument !== document) {
            renderOptions.document = ownerDocument
        }
    }

    for (var i = 0; i < indices.length; i++) {
        var nodeIndex = indices[i]
        rootNode = applyPatch(rootNode,
            index[nodeIndex],
            patches[nodeIndex],
            renderOptions)
    }

    return rootNode
}

function applyPatch(rootNode, domNode, patchList, renderOptions) {
    if (!domNode) {
        return rootNode
    }

    var newNode

    if (isArray(patchList)) {
        for (var i = 0; i < patchList.length; i++) {
            newNode = patchOp(patchList[i], domNode, renderOptions)

            if (domNode === rootNode) {
                rootNode = newNode
            }
        }
    } else {
        newNode = patchOp(patchList, domNode, renderOptions)

        if (domNode === rootNode) {
            rootNode = newNode
        }
    }

    return rootNode
}

function patchIndices(patches) {
    var indices = []

    for (var key in patches) {
        if (key !== "a") {
            indices.push(Number(key))
        }
    }

    return indices
}

});

define('virtual-dom/vtree/diff-props',['require','exports','module','is-object','../vnode/is-vhook'],function (require, exports, module) {var isObject = require("is-object")
var isHook = require("../vnode/is-vhook")

module.exports = diffProps

function diffProps(a, b) {
    var diff

    for (var aKey in a) {
        if (!(aKey in b)) {
            diff = diff || {}
            diff[aKey] = undefined
        }

        var aValue = a[aKey]
        var bValue = b[aKey]

        if (aValue === bValue) {
            continue
        } else if (isObject(aValue) && isObject(bValue)) {
            if (getPrototype(bValue) !== getPrototype(aValue)) {
                diff = diff || {}
                diff[aKey] = bValue
            } else if (isHook(bValue)) {
                 diff = diff || {}
                 diff[aKey] = bValue
            } else {
                var objectDiff = diffProps(aValue, bValue)
                if (objectDiff) {
                    diff = diff || {}
                    diff[aKey] = objectDiff
                }
            }
        } else {
            diff = diff || {}
            diff[aKey] = bValue
        }
    }

    for (var bKey in b) {
        if (!(bKey in a)) {
            diff = diff || {}
            diff[bKey] = b[bKey]
        }
    }

    return diff
}

function getPrototype(value) {
  if (Object.getPrototypeOf) {
    return Object.getPrototypeOf(value)
  } else if (value.__proto__) {
    return value.__proto__
  } else if (value.constructor) {
    return value.constructor.prototype
  }
}

});

define('virtual-dom/vtree/diff',['require','exports','module','x-is-array','../vnode/vpatch','../vnode/is-vnode','../vnode/is-vtext','../vnode/is-widget','../vnode/is-thunk','../vnode/handle-thunk','./diff-props'],function (require, exports, module) {var isArray = require("x-is-array")

var VPatch = require("../vnode/vpatch")
var isVNode = require("../vnode/is-vnode")
var isVText = require("../vnode/is-vtext")
var isWidget = require("../vnode/is-widget")
var isThunk = require("../vnode/is-thunk")
var handleThunk = require("../vnode/handle-thunk")

var diffProps = require("./diff-props")

module.exports = diff

function diff(a, b) {
    var patch = { a: a }
    walk(a, b, patch, 0)
    return patch
}

function walk(a, b, patch, index) {
    if (a === b) {
        return
    }

    var apply = patch[index]
    var applyClear = false

    if (isThunk(a) || isThunk(b)) {
        thunks(a, b, patch, index)
    } else if (b == null) {

        // If a is a widget we will add a remove patch for it
        // Otherwise any child widgets/hooks must be destroyed.
        // This prevents adding two remove patches for a widget.
        if (!isWidget(a)) {
            clearState(a, patch, index)
            apply = patch[index]
        }

        apply = appendPatch(apply, new VPatch(VPatch.REMOVE, a, b))
    } else if (isVNode(b)) {
        if (isVNode(a)) {
            if (a.tagName === b.tagName &&
                a.namespace === b.namespace &&
                a.key === b.key) {
                var propsPatch = diffProps(a.properties, b.properties)
                if (propsPatch) {
                    apply = appendPatch(apply,
                        new VPatch(VPatch.PROPS, a, propsPatch))
                }
                apply = diffChildren(a, b, patch, apply, index)
            } else {
                apply = appendPatch(apply, new VPatch(VPatch.VNODE, a, b))
                applyClear = true
            }
        } else {
            apply = appendPatch(apply, new VPatch(VPatch.VNODE, a, b))
            applyClear = true
        }
    } else if (isVText(b)) {
        if (!isVText(a)) {
            apply = appendPatch(apply, new VPatch(VPatch.VTEXT, a, b))
            applyClear = true
        } else if (a.text !== b.text) {
            apply = appendPatch(apply, new VPatch(VPatch.VTEXT, a, b))
        }
    } else if (isWidget(b)) {
        if (!isWidget(a)) {
            applyClear = true
        }

        apply = appendPatch(apply, new VPatch(VPatch.WIDGET, a, b))
    }

    if (apply) {
        patch[index] = apply
    }

    if (applyClear) {
        clearState(a, patch, index)
    }
}

function diffChildren(a, b, patch, apply, index) {
    var aChildren = a.children
    var orderedSet = reorder(aChildren, b.children)
    var bChildren = orderedSet.children

    var aLen = aChildren.length
    var bLen = bChildren.length
    var len = aLen > bLen ? aLen : bLen

    for (var i = 0; i < len; i++) {
        var leftNode = aChildren[i]
        var rightNode = bChildren[i]
        index += 1

        if (!leftNode) {
            if (rightNode) {
                // Excess nodes in b need to be added
                apply = appendPatch(apply,
                    new VPatch(VPatch.INSERT, null, rightNode))
            }
        } else {
            walk(leftNode, rightNode, patch, index)
        }

        if (isVNode(leftNode) && leftNode.count) {
            index += leftNode.count
        }
    }

    if (orderedSet.moves) {
        // Reorder nodes last
        apply = appendPatch(apply, new VPatch(
            VPatch.ORDER,
            a,
            orderedSet.moves
        ))
    }

    return apply
}

function clearState(vNode, patch, index) {
    // TODO: Make this a single walk, not two
    unhook(vNode, patch, index)
    destroyWidgets(vNode, patch, index)
}

// Patch records for all destroyed widgets must be added because we need
// a DOM node reference for the destroy function
function destroyWidgets(vNode, patch, index) {
    if (isWidget(vNode)) {
        if (typeof vNode.destroy === "function") {
            patch[index] = appendPatch(
                patch[index],
                new VPatch(VPatch.REMOVE, vNode, null)
            )
        }
    } else if (isVNode(vNode) && (vNode.hasWidgets || vNode.hasThunks)) {
        var children = vNode.children
        var len = children.length
        for (var i = 0; i < len; i++) {
            var child = children[i]
            index += 1

            destroyWidgets(child, patch, index)

            if (isVNode(child) && child.count) {
                index += child.count
            }
        }
    } else if (isThunk(vNode)) {
        thunks(vNode, null, patch, index)
    }
}

// Create a sub-patch for thunks
function thunks(a, b, patch, index) {
    var nodes = handleThunk(a, b)
    var thunkPatch = diff(nodes.a, nodes.b)
    if (hasPatches(thunkPatch)) {
        patch[index] = new VPatch(VPatch.THUNK, null, thunkPatch)
    }
}

function hasPatches(patch) {
    for (var index in patch) {
        if (index !== "a") {
            return true
        }
    }

    return false
}

// Execute hooks when two nodes are identical
function unhook(vNode, patch, index) {
    if (isVNode(vNode)) {
        if (vNode.hooks) {
            patch[index] = appendPatch(
                patch[index],
                new VPatch(
                    VPatch.PROPS,
                    vNode,
                    undefinedKeys(vNode.hooks)
                )
            )
        }

        if (vNode.descendantHooks || vNode.hasThunks) {
            var children = vNode.children
            var len = children.length
            for (var i = 0; i < len; i++) {
                var child = children[i]
                index += 1

                unhook(child, patch, index)

                if (isVNode(child) && child.count) {
                    index += child.count
                }
            }
        }
    } else if (isThunk(vNode)) {
        thunks(vNode, null, patch, index)
    }
}

function undefinedKeys(obj) {
    var result = {}

    for (var key in obj) {
        result[key] = undefined
    }

    return result
}

// List diff, naive left to right reordering
function reorder(aChildren, bChildren) {
    // O(M) time, O(M) memory
    var bChildIndex = keyIndex(bChildren)
    var bKeys = bChildIndex.keys
    var bFree = bChildIndex.free

    if (bFree.length === bChildren.length) {
        return {
            children: bChildren,
            moves: null
        }
    }

    // O(N) time, O(N) memory
    var aChildIndex = keyIndex(aChildren)
    var aKeys = aChildIndex.keys
    var aFree = aChildIndex.free

    if (aFree.length === aChildren.length) {
        return {
            children: bChildren,
            moves: null
        }
    }

    // O(MAX(N, M)) memory
    var newChildren = []

    var freeIndex = 0
    var freeCount = bFree.length
    var deletedItems = 0

    // Iterate through a and match a node in b
    // O(N) time,
    for (var i = 0 ; i < aChildren.length; i++) {
        var aItem = aChildren[i]
        var itemIndex

        if (aItem.key) {
            if (bKeys.hasOwnProperty(aItem.key)) {
                // Match up the old keys
                itemIndex = bKeys[aItem.key]
                newChildren.push(bChildren[itemIndex])

            } else {
                // Remove old keyed items
                itemIndex = i - deletedItems++
                newChildren.push(null)
            }
        } else {
            // Match the item in a with the next free item in b
            if (freeIndex < freeCount) {
                itemIndex = bFree[freeIndex++]
                newChildren.push(bChildren[itemIndex])
            } else {
                // There are no free items in b to match with
                // the free items in a, so the extra free nodes
                // are deleted.
                itemIndex = i - deletedItems++
                newChildren.push(null)
            }
        }
    }

    var lastFreeIndex = freeIndex >= bFree.length ?
        bChildren.length :
        bFree[freeIndex]

    // Iterate through b and append any new keys
    // O(M) time
    for (var j = 0; j < bChildren.length; j++) {
        var newItem = bChildren[j]

        if (newItem.key) {
            if (!aKeys.hasOwnProperty(newItem.key)) {
                // Add any new keyed items
                // We are adding new items to the end and then sorting them
                // in place. In future we should insert new items in place.
                newChildren.push(newItem)
            }
        } else if (j >= lastFreeIndex) {
            // Add any leftover non-keyed items
            newChildren.push(newItem)
        }
    }

    var simulate = newChildren.slice()
    var simulateIndex = 0
    var removes = []
    var inserts = []
    var simulateItem

    for (var k = 0; k < bChildren.length;) {
        var wantedItem = bChildren[k]
        simulateItem = simulate[simulateIndex]

        // remove items
        while (simulateItem === null && simulate.length) {
            removes.push(remove(simulate, simulateIndex, null))
            simulateItem = simulate[simulateIndex]
        }

        if (!simulateItem || simulateItem.key !== wantedItem.key) {
            // if we need a key in this position...
            if (wantedItem.key) {
                if (simulateItem && simulateItem.key) {
                    // if an insert doesn't put this key in place, it needs to move
                    if (bKeys[simulateItem.key] !== k + 1) {
                        removes.push(remove(simulate, simulateIndex, simulateItem.key))
                        simulateItem = simulate[simulateIndex]
                        // if the remove didn't put the wanted item in place, we need to insert it
                        if (!simulateItem || simulateItem.key !== wantedItem.key) {
                            inserts.push({key: wantedItem.key, to: k})
                        }
                        // items are matching, so skip ahead
                        else {
                            simulateIndex++
                        }
                    }
                    else {
                        inserts.push({key: wantedItem.key, to: k})
                    }
                }
                else {
                    inserts.push({key: wantedItem.key, to: k})
                }
                k++
            }
            // a key in simulate has no matching wanted key, remove it
            else if (simulateItem && simulateItem.key) {
                removes.push(remove(simulate, simulateIndex, simulateItem.key))
            }
        }
        else {
            simulateIndex++
            k++
        }
    }

    // remove all the remaining nodes from simulate
    while(simulateIndex < simulate.length) {
        simulateItem = simulate[simulateIndex]
        removes.push(remove(simulate, simulateIndex, simulateItem && simulateItem.key))
    }

    // If the only moves we have are deletes then we can just
    // let the delete patch remove these items.
    if (removes.length === deletedItems && !inserts.length) {
        return {
            children: newChildren,
            moves: null
        }
    }

    return {
        children: newChildren,
        moves: {
            removes: removes,
            inserts: inserts
        }
    }
}

function remove(arr, index, key) {
    arr.splice(index, 1)

    return {
        from: index,
        key: key
    }
}

function keyIndex(children) {
    var keys = {}
    var free = []
    var length = children.length

    for (var i = 0; i < length; i++) {
        var child = children[i]

        if (child.key) {
            keys[child.key] = i
        } else {
            free.push(i)
        }
    }

    return {
        keys: keys,     // A hash of key name to index
        free: free,     // An array of unkeyed item indices
    }
}

function appendPatch(apply, patch) {
    if (apply) {
        if (isArray(apply)) {
            apply.push(patch)
        } else {
            apply = [apply, patch]
        }

        return apply
    } else {
        return patch
    }
}

});

define('virtual-dom/vnode/vnode',['require','exports','module','./version','./is-vnode','./is-widget','./is-thunk','./is-vhook'],function (require, exports, module) {var version = require("./version")
var isVNode = require("./is-vnode")
var isWidget = require("./is-widget")
var isThunk = require("./is-thunk")
var isVHook = require("./is-vhook")

module.exports = VirtualNode

var noProperties = {}
var noChildren = []

function VirtualNode(tagName, properties, children, key, namespace) {
    this.tagName = tagName
    this.properties = properties || noProperties
    this.children = children || noChildren
    this.key = key != null ? String(key) : undefined
    this.namespace = (typeof namespace === "string") ? namespace : null

    var count = (children && children.length) || 0
    var descendants = 0
    var hasWidgets = false
    var hasThunks = false
    var descendantHooks = false
    var hooks

    for (var propName in properties) {
        if (properties.hasOwnProperty(propName)) {
            var property = properties[propName]
            if (isVHook(property) && property.unhook) {
                if (!hooks) {
                    hooks = {}
                }

                hooks[propName] = property
            }
        }
    }

    for (var i = 0; i < count; i++) {
        var child = children[i]
        if (isVNode(child)) {
            descendants += child.count || 0

            if (!hasWidgets && child.hasWidgets) {
                hasWidgets = true
            }

            if (!hasThunks && child.hasThunks) {
                hasThunks = true
            }

            if (!descendantHooks && (child.hooks || child.descendantHooks)) {
                descendantHooks = true
            }
        } else if (!hasWidgets && isWidget(child)) {
            if (typeof child.destroy === "function") {
                hasWidgets = true
            }
        } else if (!hasThunks && isThunk(child)) {
            hasThunks = true;
        }
    }

    this.count = count + descendants
    this.hasWidgets = hasWidgets
    this.hasThunks = hasThunks
    this.hooks = hooks
    this.descendantHooks = descendantHooks
}

VirtualNode.prototype.version = version
VirtualNode.prototype.type = "VirtualNode"

});

define('virtual-dom/vnode/vtext',['require','exports','module','./version'],function (require, exports, module) {var version = require("./version")

module.exports = VirtualText

function VirtualText(text) {
    this.text = String(text)
}

VirtualText.prototype.version = version
VirtualText.prototype.type = "VirtualText"

});

define('browser-split',['require','exports','module'],function (require, exports, module) {/*!
 * Cross-Browser Split 1.1.1
 * Copyright 2007-2012 Steven Levithan <stevenlevithan.com>
 * Available under the MIT License
 * ECMAScript compliant, uniform cross-browser split method
 */

/**
 * Splits a string into an array of strings using a regex or string separator. Matches of the
 * separator are not included in the result array. However, if `separator` is a regex that contains
 * capturing groups, backreferences are spliced into the result each time `separator` is matched.
 * Fixes browser bugs compared to the native `String.prototype.split` and can be used reliably
 * cross-browser.
 * @param {String} str String to split.
 * @param {RegExp|String} separator Regex or string to use for separating the string.
 * @param {Number} [limit] Maximum number of items to include in the result array.
 * @returns {Array} Array of substrings.
 * @example
 *
 * // Basic use
 * split('a b c d', ' ');
 * // -> ['a', 'b', 'c', 'd']
 *
 * // With limit
 * split('a b c d', ' ', 2);
 * // -> ['a', 'b']
 *
 * // Backreferences in result array
 * split('..word1 word2..', /([a-z]+)(\d+)/i);
 * // -> ['..', 'word', '1', ' ', 'word', '2', '..']
 */
module.exports = (function split(undef) {

  var nativeSplit = String.prototype.split,
    compliantExecNpcg = /()??/.exec("")[1] === undef,
    // NPCG: nonparticipating capturing group
    self;

  self = function(str, separator, limit) {
    // If `separator` is not a regex, use `nativeSplit`
    if (Object.prototype.toString.call(separator) !== "[object RegExp]") {
      return nativeSplit.call(str, separator, limit);
    }
    var output = [],
      flags = (separator.ignoreCase ? "i" : "") + (separator.multiline ? "m" : "") + (separator.extended ? "x" : "") + // Proposed for ES6
      (separator.sticky ? "y" : ""),
      // Firefox 3+
      lastLastIndex = 0,
      // Make `global` and avoid `lastIndex` issues by working with a copy
      separator = new RegExp(separator.source, flags + "g"),
      separator2, match, lastIndex, lastLength;
    str += ""; // Type-convert
    if (!compliantExecNpcg) {
      // Doesn't need flags gy, but they don't hurt
      separator2 = new RegExp("^" + separator.source + "$(?!\\s)", flags);
    }
    /* Values for `limit`, per the spec:
     * If undefined: 4294967295 // Math.pow(2, 32) - 1
     * If 0, Infinity, or NaN: 0
     * If positive number: limit = Math.floor(limit); if (limit > 4294967295) limit -= 4294967296;
     * If negative number: 4294967296 - Math.floor(Math.abs(limit))
     * If other: Type-convert, then use the above rules
     */
    limit = limit === undef ? -1 >>> 0 : // Math.pow(2, 32) - 1
    limit >>> 0; // ToUint32(limit)
    while (match = separator.exec(str)) {
      // `separator.lastIndex` is not reliable cross-browser
      lastIndex = match.index + match[0].length;
      if (lastIndex > lastLastIndex) {
        output.push(str.slice(lastLastIndex, match.index));
        // Fix browsers whose `exec` methods don't consistently return `undefined` for
        // nonparticipating capturing groups
        if (!compliantExecNpcg && match.length > 1) {
          match[0].replace(separator2, function() {
            for (var i = 1; i < arguments.length - 2; i++) {
              if (arguments[i] === undef) {
                match[i] = undef;
              }
            }
          });
        }
        if (match.length > 1 && match.index < str.length) {
          Array.prototype.push.apply(output, match.slice(1));
        }
        lastLength = match[0].length;
        lastLastIndex = lastIndex;
        if (output.length >= limit) {
          break;
        }
      }
      if (separator.lastIndex === match.index) {
        separator.lastIndex++; // Avoid an infinite loop
      }
    }
    if (lastLastIndex === str.length) {
      if (lastLength || !separator.test("")) {
        output.push("");
      }
    } else {
      output.push(str.slice(lastLastIndex));
    }
    return output.length > limit ? output.slice(0, limit) : output;
  };

  return self;
})();

});

define('virtual-dom/virtual-hyperscript/parse-tag',['require','exports','module','browser-split'],function (require, exports, module) {'use strict';

var split = require('browser-split');

var classIdSplit = /([\.#]?[a-zA-Z0-9_:-]+)/;
var notClassId = /^\.|#/;

module.exports = parseTag;

function parseTag(tag, props) {
    if (!tag) {
        return 'DIV';
    }

    var noId = !(props.hasOwnProperty('id'));

    var tagParts = split(tag, classIdSplit);
    var tagName = null;

    if (notClassId.test(tagParts[1])) {
        tagName = 'DIV';
    }

    var classes, part, type, i;

    for (i = 0; i < tagParts.length; i++) {
        part = tagParts[i];

        if (!part) {
            continue;
        }

        type = part.charAt(0);

        if (!tagName) {
            tagName = part;
        } else if (type === '.') {
            classes = classes || [];
            classes.push(part.substring(1, part.length));
        } else if (type === '#' && noId) {
            props.id = part.substring(1, part.length);
        }
    }

    if (classes) {
        if (props.className) {
            classes.push(props.className);
        }

        props.className = classes.join(' ');
    }

    return props.namespace ? tagName : tagName.toUpperCase();
}

});

define('virtual-dom/virtual-hyperscript/hooks/soft-set-hook',['require','exports','module'],function (require, exports, module) {'use strict';

module.exports = SoftSetHook;

function SoftSetHook(value) {
    if (!(this instanceof SoftSetHook)) {
        return new SoftSetHook(value);
    }

    this.value = value;
}

SoftSetHook.prototype.hook = function (node, propertyName) {
    if (node[propertyName] !== this.value) {
        node[propertyName] = this.value;
    }
};

});

define('ev-store',['require','exports','module'],function (require, exports, module) {'use strict';

var MY_VERSION = '7';

var hashKey = '__EV_STORE_KEY@' + MY_VERSION;

module.exports = EvStore;

function EvStore(elem) {
    var hash = elem[hashKey];

    if (!hash) {
        hash = elem[hashKey] = {};
    }

    return hash;
}

});

define('virtual-dom/virtual-hyperscript/hooks/ev-hook',['require','exports','module','ev-store'],function (require, exports, module) {'use strict';

var EvStore = require('ev-store');

module.exports = EvHook;

function EvHook(value) {
    if (!(this instanceof EvHook)) {
        return new EvHook(value);
    }

    this.value = value;
}

EvHook.prototype.hook = function (node, propertyName) {
    var es = EvStore(node);
    var propName = propertyName.substr(3);

    es[propName] = this.value;
};

EvHook.prototype.unhook = function(node, propertyName) {
    var es = EvStore(node);
    var propName = propertyName.substr(3);

    es[propName] = undefined;
};

});

define('virtual-dom/virtual-hyperscript/index',['require','exports','module','x-is-array','../vnode/vnode','../vnode/vtext','../vnode/is-vnode','../vnode/is-vtext','../vnode/is-widget','../vnode/is-vhook','../vnode/is-thunk','./parse-tag','./hooks/soft-set-hook','./hooks/ev-hook'],function (require, exports, module) {'use strict';

var isArray = require('x-is-array');

var VNode = require('../vnode/vnode');
var VText = require('../vnode/vtext');
var isVNode = require('../vnode/is-vnode');
var isVText = require('../vnode/is-vtext');
var isWidget = require('../vnode/is-widget');
var isHook = require('../vnode/is-vhook');
var isVThunk = require('../vnode/is-thunk');

var parseTag = require('./parse-tag');
var softSetHook = require('./hooks/soft-set-hook');
var evHook = require('./hooks/ev-hook');

module.exports = h;

function h(tagName, properties, children) {
    var childNodes = [];
    var tag, props, key, namespace;

    if (!children && isChildren(properties)) {
        children = properties;
        props = {};
    }

    props = props || properties || {};
    tag = parseTag(tagName, props);

    // support keys
    if (props.hasOwnProperty('key')) {
        key = props.key;
        props.key = undefined;
    }

    // support namespace
    if (props.hasOwnProperty('namespace')) {
        namespace = props.namespace;
        props.namespace = undefined;
    }

    // fix cursor bug
    if (tag === 'INPUT' &&
        !namespace &&
        props.hasOwnProperty('value') &&
        props.value !== undefined &&
        !isHook(props.value)
    ) {
        props.value = softSetHook(props.value);
    }

    transformProperties(props);

    if (children !== undefined && children !== null) {
        addChild(children, childNodes, tag, props);
    }


    return new VNode(tag, props, childNodes, key, namespace);
}

function addChild(c, childNodes, tag, props) {
    if (typeof c === 'string') {
        childNodes.push(new VText(c));
    } else if (isChild(c)) {
        childNodes.push(c);
    } else if (isArray(c)) {
        for (var i = 0; i < c.length; i++) {
            addChild(c[i], childNodes, tag, props);
        }
    } else if (c === null || c === undefined) {
        return;
    } else {
        throw UnexpectedVirtualElement({
            foreignObject: c,
            parentVnode: {
                tagName: tag,
                properties: props
            }
        });
    }
}

function transformProperties(props) {
    for (var propName in props) {
        if (props.hasOwnProperty(propName)) {
            var value = props[propName];

            if (isHook(value)) {
                continue;
            }

            if (propName.substr(0, 3) === 'ev-') {
                // add ev-foo support
                props[propName] = evHook(value);
            }
        }
    }
}

function isChild(x) {
    return isVNode(x) || isVText(x) || isWidget(x) || isVThunk(x);
}

function isChildren(x) {
    return typeof x === 'string' || isArray(x) || isChild(x);
}

function UnexpectedVirtualElement(data) {
    var err = new Error();

    err.type = 'virtual-hyperscript.unexpected.virtual-element';
    err.message = 'Unexpected virtual child passed to h().\n' +
        'Expected a VNode / Vthunk / VWidget / string but:\n' +
        'got:\n' +
        errorString(data.foreignObject) +
        '.\n' +
        'The parent vnode is:\n' +
        errorString(data.parentVnode)
        '\n' +
        'Suggested fix: change your `h(..., [ ... ])` callsite.';
    err.foreignObject = data.foreignObject;
    err.parentVnode = data.parentVnode;

    return err;
}

function errorString(obj) {
    try {
        return JSON.stringify(obj, null, '    ');
    } catch (e) {
        return String(obj);
    }
}

});

define('virtual-dom/virtual-hyperscript/svg-attribute-namespace',['require','exports','module'],function (require, exports, module) {'use strict';

var DEFAULT_NAMESPACE = null;
var EV_NAMESPACE = 'http://www.w3.org/2001/xml-events';
var XLINK_NAMESPACE = 'http://www.w3.org/1999/xlink';
var XML_NAMESPACE = 'http://www.w3.org/XML/1998/namespace';

// http://www.w3.org/TR/SVGTiny12/attributeTable.html
// http://www.w3.org/TR/SVG/attindex.html
var SVG_PROPERTIES = {
    'about': DEFAULT_NAMESPACE,
    'accent-height': DEFAULT_NAMESPACE,
    'accumulate': DEFAULT_NAMESPACE,
    'additive': DEFAULT_NAMESPACE,
    'alignment-baseline': DEFAULT_NAMESPACE,
    'alphabetic': DEFAULT_NAMESPACE,
    'amplitude': DEFAULT_NAMESPACE,
    'arabic-form': DEFAULT_NAMESPACE,
    'ascent': DEFAULT_NAMESPACE,
    'attributeName': DEFAULT_NAMESPACE,
    'attributeType': DEFAULT_NAMESPACE,
    'azimuth': DEFAULT_NAMESPACE,
    'bandwidth': DEFAULT_NAMESPACE,
    'baseFrequency': DEFAULT_NAMESPACE,
    'baseProfile': DEFAULT_NAMESPACE,
    'baseline-shift': DEFAULT_NAMESPACE,
    'bbox': DEFAULT_NAMESPACE,
    'begin': DEFAULT_NAMESPACE,
    'bias': DEFAULT_NAMESPACE,
    'by': DEFAULT_NAMESPACE,
    'calcMode': DEFAULT_NAMESPACE,
    'cap-height': DEFAULT_NAMESPACE,
    'class': DEFAULT_NAMESPACE,
    'clip': DEFAULT_NAMESPACE,
    'clip-path': DEFAULT_NAMESPACE,
    'clip-rule': DEFAULT_NAMESPACE,
    'clipPathUnits': DEFAULT_NAMESPACE,
    'color': DEFAULT_NAMESPACE,
    'color-interpolation': DEFAULT_NAMESPACE,
    'color-interpolation-filters': DEFAULT_NAMESPACE,
    'color-profile': DEFAULT_NAMESPACE,
    'color-rendering': DEFAULT_NAMESPACE,
    'content': DEFAULT_NAMESPACE,
    'contentScriptType': DEFAULT_NAMESPACE,
    'contentStyleType': DEFAULT_NAMESPACE,
    'cursor': DEFAULT_NAMESPACE,
    'cx': DEFAULT_NAMESPACE,
    'cy': DEFAULT_NAMESPACE,
    'd': DEFAULT_NAMESPACE,
    'datatype': DEFAULT_NAMESPACE,
    'defaultAction': DEFAULT_NAMESPACE,
    'descent': DEFAULT_NAMESPACE,
    'diffuseConstant': DEFAULT_NAMESPACE,
    'direction': DEFAULT_NAMESPACE,
    'display': DEFAULT_NAMESPACE,
    'divisor': DEFAULT_NAMESPACE,
    'dominant-baseline': DEFAULT_NAMESPACE,
    'dur': DEFAULT_NAMESPACE,
    'dx': DEFAULT_NAMESPACE,
    'dy': DEFAULT_NAMESPACE,
    'edgeMode': DEFAULT_NAMESPACE,
    'editable': DEFAULT_NAMESPACE,
    'elevation': DEFAULT_NAMESPACE,
    'enable-background': DEFAULT_NAMESPACE,
    'end': DEFAULT_NAMESPACE,
    'ev:event': EV_NAMESPACE,
    'event': DEFAULT_NAMESPACE,
    'exponent': DEFAULT_NAMESPACE,
    'externalResourcesRequired': DEFAULT_NAMESPACE,
    'fill': DEFAULT_NAMESPACE,
    'fill-opacity': DEFAULT_NAMESPACE,
    'fill-rule': DEFAULT_NAMESPACE,
    'filter': DEFAULT_NAMESPACE,
    'filterRes': DEFAULT_NAMESPACE,
    'filterUnits': DEFAULT_NAMESPACE,
    'flood-color': DEFAULT_NAMESPACE,
    'flood-opacity': DEFAULT_NAMESPACE,
    'focusHighlight': DEFAULT_NAMESPACE,
    'focusable': DEFAULT_NAMESPACE,
    'font-family': DEFAULT_NAMESPACE,
    'font-size': DEFAULT_NAMESPACE,
    'font-size-adjust': DEFAULT_NAMESPACE,
    'font-stretch': DEFAULT_NAMESPACE,
    'font-style': DEFAULT_NAMESPACE,
    'font-variant': DEFAULT_NAMESPACE,
    'font-weight': DEFAULT_NAMESPACE,
    'format': DEFAULT_NAMESPACE,
    'from': DEFAULT_NAMESPACE,
    'fx': DEFAULT_NAMESPACE,
    'fy': DEFAULT_NAMESPACE,
    'g1': DEFAULT_NAMESPACE,
    'g2': DEFAULT_NAMESPACE,
    'glyph-name': DEFAULT_NAMESPACE,
    'glyph-orientation-horizontal': DEFAULT_NAMESPACE,
    'glyph-orientation-vertical': DEFAULT_NAMESPACE,
    'glyphRef': DEFAULT_NAMESPACE,
    'gradientTransform': DEFAULT_NAMESPACE,
    'gradientUnits': DEFAULT_NAMESPACE,
    'handler': DEFAULT_NAMESPACE,
    'hanging': DEFAULT_NAMESPACE,
    'height': DEFAULT_NAMESPACE,
    'horiz-adv-x': DEFAULT_NAMESPACE,
    'horiz-origin-x': DEFAULT_NAMESPACE,
    'horiz-origin-y': DEFAULT_NAMESPACE,
    'id': DEFAULT_NAMESPACE,
    'ideographic': DEFAULT_NAMESPACE,
    'image-rendering': DEFAULT_NAMESPACE,
    'in': DEFAULT_NAMESPACE,
    'in2': DEFAULT_NAMESPACE,
    'initialVisibility': DEFAULT_NAMESPACE,
    'intercept': DEFAULT_NAMESPACE,
    'k': DEFAULT_NAMESPACE,
    'k1': DEFAULT_NAMESPACE,
    'k2': DEFAULT_NAMESPACE,
    'k3': DEFAULT_NAMESPACE,
    'k4': DEFAULT_NAMESPACE,
    'kernelMatrix': DEFAULT_NAMESPACE,
    'kernelUnitLength': DEFAULT_NAMESPACE,
    'kerning': DEFAULT_NAMESPACE,
    'keyPoints': DEFAULT_NAMESPACE,
    'keySplines': DEFAULT_NAMESPACE,
    'keyTimes': DEFAULT_NAMESPACE,
    'lang': DEFAULT_NAMESPACE,
    'lengthAdjust': DEFAULT_NAMESPACE,
    'letter-spacing': DEFAULT_NAMESPACE,
    'lighting-color': DEFAULT_NAMESPACE,
    'limitingConeAngle': DEFAULT_NAMESPACE,
    'local': DEFAULT_NAMESPACE,
    'marker-end': DEFAULT_NAMESPACE,
    'marker-mid': DEFAULT_NAMESPACE,
    'marker-start': DEFAULT_NAMESPACE,
    'markerHeight': DEFAULT_NAMESPACE,
    'markerUnits': DEFAULT_NAMESPACE,
    'markerWidth': DEFAULT_NAMESPACE,
    'mask': DEFAULT_NAMESPACE,
    'maskContentUnits': DEFAULT_NAMESPACE,
    'maskUnits': DEFAULT_NAMESPACE,
    'mathematical': DEFAULT_NAMESPACE,
    'max': DEFAULT_NAMESPACE,
    'media': DEFAULT_NAMESPACE,
    'mediaCharacterEncoding': DEFAULT_NAMESPACE,
    'mediaContentEncodings': DEFAULT_NAMESPACE,
    'mediaSize': DEFAULT_NAMESPACE,
    'mediaTime': DEFAULT_NAMESPACE,
    'method': DEFAULT_NAMESPACE,
    'min': DEFAULT_NAMESPACE,
    'mode': DEFAULT_NAMESPACE,
    'name': DEFAULT_NAMESPACE,
    'nav-down': DEFAULT_NAMESPACE,
    'nav-down-left': DEFAULT_NAMESPACE,
    'nav-down-right': DEFAULT_NAMESPACE,
    'nav-left': DEFAULT_NAMESPACE,
    'nav-next': DEFAULT_NAMESPACE,
    'nav-prev': DEFAULT_NAMESPACE,
    'nav-right': DEFAULT_NAMESPACE,
    'nav-up': DEFAULT_NAMESPACE,
    'nav-up-left': DEFAULT_NAMESPACE,
    'nav-up-right': DEFAULT_NAMESPACE,
    'numOctaves': DEFAULT_NAMESPACE,
    'observer': DEFAULT_NAMESPACE,
    'offset': DEFAULT_NAMESPACE,
    'opacity': DEFAULT_NAMESPACE,
    'operator': DEFAULT_NAMESPACE,
    'order': DEFAULT_NAMESPACE,
    'orient': DEFAULT_NAMESPACE,
    'orientation': DEFAULT_NAMESPACE,
    'origin': DEFAULT_NAMESPACE,
    'overflow': DEFAULT_NAMESPACE,
    'overlay': DEFAULT_NAMESPACE,
    'overline-position': DEFAULT_NAMESPACE,
    'overline-thickness': DEFAULT_NAMESPACE,
    'panose-1': DEFAULT_NAMESPACE,
    'path': DEFAULT_NAMESPACE,
    'pathLength': DEFAULT_NAMESPACE,
    'patternContentUnits': DEFAULT_NAMESPACE,
    'patternTransform': DEFAULT_NAMESPACE,
    'patternUnits': DEFAULT_NAMESPACE,
    'phase': DEFAULT_NAMESPACE,
    'playbackOrder': DEFAULT_NAMESPACE,
    'pointer-events': DEFAULT_NAMESPACE,
    'points': DEFAULT_NAMESPACE,
    'pointsAtX': DEFAULT_NAMESPACE,
    'pointsAtY': DEFAULT_NAMESPACE,
    'pointsAtZ': DEFAULT_NAMESPACE,
    'preserveAlpha': DEFAULT_NAMESPACE,
    'preserveAspectRatio': DEFAULT_NAMESPACE,
    'primitiveUnits': DEFAULT_NAMESPACE,
    'propagate': DEFAULT_NAMESPACE,
    'property': DEFAULT_NAMESPACE,
    'r': DEFAULT_NAMESPACE,
    'radius': DEFAULT_NAMESPACE,
    'refX': DEFAULT_NAMESPACE,
    'refY': DEFAULT_NAMESPACE,
    'rel': DEFAULT_NAMESPACE,
    'rendering-intent': DEFAULT_NAMESPACE,
    'repeatCount': DEFAULT_NAMESPACE,
    'repeatDur': DEFAULT_NAMESPACE,
    'requiredExtensions': DEFAULT_NAMESPACE,
    'requiredFeatures': DEFAULT_NAMESPACE,
    'requiredFonts': DEFAULT_NAMESPACE,
    'requiredFormats': DEFAULT_NAMESPACE,
    'resource': DEFAULT_NAMESPACE,
    'restart': DEFAULT_NAMESPACE,
    'result': DEFAULT_NAMESPACE,
    'rev': DEFAULT_NAMESPACE,
    'role': DEFAULT_NAMESPACE,
    'rotate': DEFAULT_NAMESPACE,
    'rx': DEFAULT_NAMESPACE,
    'ry': DEFAULT_NAMESPACE,
    'scale': DEFAULT_NAMESPACE,
    'seed': DEFAULT_NAMESPACE,
    'shape-rendering': DEFAULT_NAMESPACE,
    'slope': DEFAULT_NAMESPACE,
    'snapshotTime': DEFAULT_NAMESPACE,
    'spacing': DEFAULT_NAMESPACE,
    'specularConstant': DEFAULT_NAMESPACE,
    'specularExponent': DEFAULT_NAMESPACE,
    'spreadMethod': DEFAULT_NAMESPACE,
    'startOffset': DEFAULT_NAMESPACE,
    'stdDeviation': DEFAULT_NAMESPACE,
    'stemh': DEFAULT_NAMESPACE,
    'stemv': DEFAULT_NAMESPACE,
    'stitchTiles': DEFAULT_NAMESPACE,
    'stop-color': DEFAULT_NAMESPACE,
    'stop-opacity': DEFAULT_NAMESPACE,
    'strikethrough-position': DEFAULT_NAMESPACE,
    'strikethrough-thickness': DEFAULT_NAMESPACE,
    'string': DEFAULT_NAMESPACE,
    'stroke': DEFAULT_NAMESPACE,
    'stroke-dasharray': DEFAULT_NAMESPACE,
    'stroke-dashoffset': DEFAULT_NAMESPACE,
    'stroke-linecap': DEFAULT_NAMESPACE,
    'stroke-linejoin': DEFAULT_NAMESPACE,
    'stroke-miterlimit': DEFAULT_NAMESPACE,
    'stroke-opacity': DEFAULT_NAMESPACE,
    'stroke-width': DEFAULT_NAMESPACE,
    'surfaceScale': DEFAULT_NAMESPACE,
    'syncBehavior': DEFAULT_NAMESPACE,
    'syncBehaviorDefault': DEFAULT_NAMESPACE,
    'syncMaster': DEFAULT_NAMESPACE,
    'syncTolerance': DEFAULT_NAMESPACE,
    'syncToleranceDefault': DEFAULT_NAMESPACE,
    'systemLanguage': DEFAULT_NAMESPACE,
    'tableValues': DEFAULT_NAMESPACE,
    'target': DEFAULT_NAMESPACE,
    'targetX': DEFAULT_NAMESPACE,
    'targetY': DEFAULT_NAMESPACE,
    'text-anchor': DEFAULT_NAMESPACE,
    'text-decoration': DEFAULT_NAMESPACE,
    'text-rendering': DEFAULT_NAMESPACE,
    'textLength': DEFAULT_NAMESPACE,
    'timelineBegin': DEFAULT_NAMESPACE,
    'title': DEFAULT_NAMESPACE,
    'to': DEFAULT_NAMESPACE,
    'transform': DEFAULT_NAMESPACE,
    'transformBehavior': DEFAULT_NAMESPACE,
    'type': DEFAULT_NAMESPACE,
    'typeof': DEFAULT_NAMESPACE,
    'u1': DEFAULT_NAMESPACE,
    'u2': DEFAULT_NAMESPACE,
    'underline-position': DEFAULT_NAMESPACE,
    'underline-thickness': DEFAULT_NAMESPACE,
    'unicode': DEFAULT_NAMESPACE,
    'unicode-bidi': DEFAULT_NAMESPACE,
    'unicode-range': DEFAULT_NAMESPACE,
    'units-per-em': DEFAULT_NAMESPACE,
    'v-alphabetic': DEFAULT_NAMESPACE,
    'v-hanging': DEFAULT_NAMESPACE,
    'v-ideographic': DEFAULT_NAMESPACE,
    'v-mathematical': DEFAULT_NAMESPACE,
    'values': DEFAULT_NAMESPACE,
    'version': DEFAULT_NAMESPACE,
    'vert-adv-y': DEFAULT_NAMESPACE,
    'vert-origin-x': DEFAULT_NAMESPACE,
    'vert-origin-y': DEFAULT_NAMESPACE,
    'viewBox': DEFAULT_NAMESPACE,
    'viewTarget': DEFAULT_NAMESPACE,
    'visibility': DEFAULT_NAMESPACE,
    'width': DEFAULT_NAMESPACE,
    'widths': DEFAULT_NAMESPACE,
    'word-spacing': DEFAULT_NAMESPACE,
    'writing-mode': DEFAULT_NAMESPACE,
    'x': DEFAULT_NAMESPACE,
    'x-height': DEFAULT_NAMESPACE,
    'x1': DEFAULT_NAMESPACE,
    'x2': DEFAULT_NAMESPACE,
    'xChannelSelector': DEFAULT_NAMESPACE,
    'xlink:actuate': XLINK_NAMESPACE,
    'xlink:arcrole': XLINK_NAMESPACE,
    'xlink:href': XLINK_NAMESPACE,
    'xlink:role': XLINK_NAMESPACE,
    'xlink:show': XLINK_NAMESPACE,
    'xlink:title': XLINK_NAMESPACE,
    'xlink:type': XLINK_NAMESPACE,
    'xml:base': XML_NAMESPACE,
    'xml:id': XML_NAMESPACE,
    'xml:lang': XML_NAMESPACE,
    'xml:space': XML_NAMESPACE,
    'y': DEFAULT_NAMESPACE,
    'y1': DEFAULT_NAMESPACE,
    'y2': DEFAULT_NAMESPACE,
    'yChannelSelector': DEFAULT_NAMESPACE,
    'z': DEFAULT_NAMESPACE,
    'zoomAndPan': DEFAULT_NAMESPACE
};

module.exports = SVGAttributeNamespace;

function SVGAttributeNamespace(value) {
  if (SVG_PROPERTIES.hasOwnProperty(value)) {
    return SVG_PROPERTIES[value];
  }
}

});

define('virtual-dom/virtual-hyperscript/hooks/attribute-hook',['require','exports','module'],function (require, exports, module) {'use strict';

module.exports = AttributeHook;

function AttributeHook(namespace, value) {
    if (!(this instanceof AttributeHook)) {
        return new AttributeHook(namespace, value);
    }

    this.namespace = namespace;
    this.value = value;
}

AttributeHook.prototype.hook = function (node, prop, prev) {
    if (prev && prev.type === 'AttributeHook' &&
        prev.value === this.value &&
        prev.namespace === this.namespace) {
        return;
    }

    node.setAttributeNS(this.namespace, prop, this.value);
};

AttributeHook.prototype.unhook = function (node, prop, next) {
    if (next && next.type === 'AttributeHook' &&
        next.namespace === this.namespace) {
        return;
    }

    var colonPosition = prop.indexOf(':');
    var localName = colonPosition > -1 ? prop.substr(colonPosition + 1) : prop;
    node.removeAttributeNS(this.namespace, localName);
};

AttributeHook.prototype.type = 'AttributeHook';

});

define('virtual-dom/virtual-hyperscript/svg',['require','exports','module','x-is-array','./index','./svg-attribute-namespace','./hooks/attribute-hook'],function (require, exports, module) {'use strict';

var isArray = require('x-is-array');

var h = require('./index');


var SVGAttributeNamespace = require('./svg-attribute-namespace');
var attributeHook = require('./hooks/attribute-hook');

var SVG_NAMESPACE = 'http://www.w3.org/2000/svg';

module.exports = svg;

function svg(tagName, properties, children) {
    if (!children && isChildren(properties)) {
        children = properties;
        properties = {};
    }

    properties = properties || {};

    // set namespace for svg
    properties.namespace = SVG_NAMESPACE;

    var attributes = properties.attributes || (properties.attributes = {});

    for (var key in properties) {
        if (!properties.hasOwnProperty(key)) {
            continue;
        }

        var namespace = SVGAttributeNamespace(key);

        if (namespace === undefined) { // not a svg attribute
            continue;
        }

        var value = properties[key];

        if (typeof value !== 'string' &&
            typeof value !== 'number' &&
            typeof value !== 'boolean'
        ) {
            continue;
        }

        if (namespace !== null) { // namespaced attribute
            properties[key] = attributeHook(namespace, value);
            continue;
        }

        attributes[key] = value
        properties[key] = undefined
    }

    return h(tagName, properties, children);
}

function isChildren(x) {
    return typeof x === 'string' || isArray(x);
}

});

define('Magic',['exports', 'module', 'nbd/View', 'nbd/util/extend', 'nbd/util/async', './sax', './transformTag', './virtual-dom/vdom/create-element', './virtual-dom/vdom/patch', './virtual-dom/vtree/diff', './virtual-dom/virtual-hyperscript/index', './virtual-dom/virtual-hyperscript/svg'], function (exports, module, _nbdView, _nbdUtilExtend, _nbdUtilAsync, _sax, _transformTag, _virtualDomVdomCreateElement, _virtualDomVdomPatch, _virtualDomVtreeDiff, _virtualDomVirtualHyperscriptIndex, _virtualDomVirtualHyperscriptSvg) {
  'use strict';

  var _createClass = (function () { function defineProperties(target, props) { for (var i = 0; i < props.length; i++) { var descriptor = props[i]; descriptor.enumerable = descriptor.enumerable || false; descriptor.configurable = true; if ('value' in descriptor) descriptor.writable = true; Object.defineProperty(target, descriptor.key, descriptor); } } return function (Constructor, protoProps, staticProps) { if (protoProps) defineProperties(Constructor.prototype, protoProps); if (staticProps) defineProperties(Constructor, staticProps); return Constructor; }; })();

  function _interopRequire(obj) { return obj && obj.__esModule ? obj['default'] : obj; }

  function _classCallCheck(instance, Constructor) { if (!(instance instanceof Constructor)) { throw new TypeError('Cannot call a class as a function'); } }

  var _View = _interopRequire(_nbdView);

  var _extend = _interopRequire(_nbdUtilExtend);

  var _async = _interopRequire(_nbdUtilAsync);

  var _sax2 = _interopRequire(_sax);

  var _transform = _interopRequire(_transformTag);

  var _createElement = _interopRequire(_virtualDomVdomCreateElement);

  var _patch = _interopRequire(_virtualDomVdomPatch);

  var _diff = _interopRequire(_virtualDomVtreeDiff);

  var _h = _interopRequire(_virtualDomVirtualHyperscriptIndex);

  var _svg = _interopRequire(_virtualDomVirtualHyperscriptSvg);

  var _parser = _sax2.parser(true, {
    html5: true,
    trim: true,
    normalize: true,
    lowercase: true
  });
  var tagstack = [];

  function debounce(callback, ctxt) {
    return function wrapper() {
      if (!wrapper._called) {
        wrapper._called = _async(function () {
          wrapper._called = false;
          callback.call(ctxt);
        });
      }
    };
  }

  var EventHandler = (function () {
    function EventHandler(handler) {
      _classCallCheck(this, EventHandler);

      this.handler = handler;
      this.listener = this.listener.bind(this);
    }

    _createClass(EventHandler, [{
      key: 'listener',
      value: function listener(event) {
        this.caller(this.handler.events[event.type], event);
      }
    }, {
      key: 'caller',
      value: function caller(spec, event) {
        var _this = this;

        if (!spec) {
          return;
        }
        switch (typeof spec) {
          case 'function':
            spec.call(event.delegateTarget || event.currentTarget, event);
            break;
          case 'string':
            this.handler[spec](event);
            break;
          case 'object':
            if (Array.isArray(spec)) {
              spec.forEach(function (s) {
                return _this.caller(s, event);
              });
            } else {
              for (var selector in spec) {
                // Find all matching elements
                var matches = event.currentTarget.querySelectorAll(selector);

                // If event.target is, or is a child of matching element
                var found = this.find(matches, event.target);
                if (found) {
                  event.delegateTarget = found;
                  this.caller(spec[selector], event);
                  delete event.delegateTarget;
                }
              }
            }
            break;
        }
      }
    }, {
      key: 'find',
      value: function find(matches, target) {
        var _iteratorNormalCompletion = true;
        var _didIteratorError = false;
        var _iteratorError = undefined;

        try {
          for (var _iterator = matches[Symbol.iterator](), _step; !(_iteratorNormalCompletion = (_step = _iterator.next()).done); _iteratorNormalCompletion = true) {
            var match = _step.value;

            // Is the target itself or contains the target
            if (match === target || match.contains(target)) {
              return match;
            }
          }
        } catch (err) {
          _didIteratorError = true;
          _iteratorError = err;
        } finally {
          try {
            if (!_iteratorNormalCompletion && _iterator['return']) {
              _iterator['return']();
            }
          } finally {
            if (_didIteratorError) {
              throw _iteratorError;
            }
          }
        }
      }
    }, {
      key: 'hook',
      value: function hook(node) {
        for (var _event in this.handler.events) {
          node.addEventListener(_event, this.listener, false);
        }
      }
    }, {
      key: 'unhook',
      value: function unhook(node) {
        for (var _event2 in this.handler.events) {
          node.removeEventListener(_event2, this.listener, false);
        }
      }
    }]);

    return EventHandler;
  })();

  var tree = undefined,
      handler = undefined;

  _extend(_parser, {
    onopentag: function onopentag(_ref) {
      var name = _ref.name;
      var attributes = _ref.attributes;

      if (name.toLowerCase() === 'svg') {
        _parser.svg = true;
      }

      var tag = { name: name, attributes: attributes, children: [], svg: _parser.svg };
      _transform(tag);

      if (tagstack[tagstack.length - 1]) {
        tagstack[tagstack.length - 1].children.push(tag);
      } else if (handler && handler.events) {
        tag.properties['event-mappable'] = new EventHandler(handler);
      }
      tagstack.push(tag);
    },
    onclosetag: function onclosetag() {
      var tag = tagstack.pop();

      // switch to svg() when in svg mode
      var vnode = (tag.svg ? _svg : _h)(tag.name, tag.properties, tag.children);

      if (tag.name.toLowerCase() === 'svg') {
        _parser.svg = false;
      }
      var last = tagstack[tagstack.length - 1];
      if (last) {
        last.children.splice(last.children.lastIndexOf(tag), 1, vnode);
      } else {
        tree = vnode;
      }
    },
    ontext: function ontext(text) {
      if (!text.trim()) {
        return;
      }
      if (tagstack[tagstack.length - 1]) {
        tagstack[tagstack.length - 1].children.push(text);
      }
    },
    onend: function onend() {
      tagstack.length = 0;
    }
  });

  module.exports = _View.extend({
    init: function init() {
      for (var _len = arguments.length, args = Array(_len), _key = 0; _key < _len; _key++) {
        args[_key] = arguments[_key];
      }

      this._super.apply(this, args);
      if (this._model.on) {
        this.listenTo(this._model, 'all', debounce(this.render, this));
      }

      this.on({
        prerender: function prerender() {
          handler = this;
        },
        postrender: function postrender() {
          handler = null;
        }
      });
    }
  }, {
    domify: function domify(html) {
      tree = null;
      _parser.write(html).close();
      return tree;
    },

    appendTo: function appendTo(tree, $context) {
      tree._el = _createElement(tree);
      return _View.appendTo(tree._el, $context);
    },

    replace: function replace(oldtree, newtree) {
      var p = _diff(oldtree, newtree);
      if (newtree) {
        newtree._el = oldtree._el;
      }
      _patch(oldtree._el, p);
    },

    find: function find($root, selector) {
      if (!selector) {
        return $root._el || $root;
      }
      return _View.find($root._el || $root, selector);
    },

    remove: function remove(tree) {
      this.replace(tree);
    }
  });
});

