import View from 'nbd/View';
import extend from 'nbd/util/extend';
import async from 'nbd/util/async';
import sax from 'sax';
import vdom from 'virtual-dom';

const _parser = sax.parser();
const tagstack = [];

const blocking = Symbol('debounced');

function debounce(fn) {
  if (fn[blocking]) { return; }
  const retval = fn.call(this);
  fn[blocking] = true;
  async(() => delete fn[blocking]);
  return retval;
}

let tree;

function isAttribute(name) {
  return !(/^value$/i.test(name));
}

function transformAttributes(properties) {
  properties.attributes = {};
  for (let prop in properties) {
    if (properties.hasOwnProperty(prop) && prop !== 'attributes') {
      if (prop.toLowerCase() === 'class') {
        properties.className = properties[prop];
        delete properties[prop];
      }
      if (isAttribute(prop)) {
        properties.attributes[prop] = properties[prop];
        delete properties[prop];
      }
    }
  }
}

extend(_parser, {
  onopentag({ name, attributes }) {
    transformAttributes(attributes);
    const tag = { name, attributes, children: [] };
    if (tagstack[tagstack.length - 1]) {
      tagstack[tagstack.length - 1].children.push(tag);
    }
    tagstack.push(tag);
  },
  onclosetag() {
    const tag = tagstack.pop();
    let vnode = vdom.h(tag.name, tag.attributes, tag.children);
    const last = tagstack[tagstack.length - 1];
    if (last) {
      last.children.splice(last.children.lastIndexOf(tag), 1, vnode);
    }
    else {
      tree = vnode;
    }
  },
  ontext(text) {
    if (!text.trim()) {
      return;
    }
    if (tagstack[tagstack.length - 1]) {
      tagstack[tagstack.length - 1].children.push(text);
    }
  },
  onend() {
    tagstack.length = 0;
  }
});

export default class Magic extends View.extend({
  init(...args) {
    this._super(...args);
    if (this._model.on) {
      this.listenTo(this._model, 'all', () => debounce.call(this, this.render));
    }
  },

  template(data) {
    return this.mustache && this.mustache(data, this.partials);
  }
}) {
  static domify(html) {
    tree = null;
    _parser.write(html).close();
    return tree;
  }

  static appendTo(tree, $context) {
    tree._el = vdom.create(tree);
    return super.appendTo(tree._el, $context);
  }

  static replace(oldtree, newtree) {
    const patch = vdom.diff(oldtree, newtree);
    vdom.patch(newtree._el = oldtree._el, patch);
  }

  static find($root, selector) {
    return super.find($root._el || $root, selector);
  }

  static remove($el) {
    return super.remove($el._el || $el);
  }
}
