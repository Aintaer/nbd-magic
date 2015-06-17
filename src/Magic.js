import View from 'nbd/View';
import extend from 'nbd/util/extend';
import async from 'nbd/util/async';

import sax from './sax';
import transform from './transformTag';

import createElement from './virtual-dom/vdom/create-element';
import patch from './virtual-dom/vdom/patch';
import diff from './virtual-dom/vtree/diff';
import h from './virtual-dom/virtual-hyperscript/index';
import svg from './virtual-dom/virtual-hyperscript/svg';

const _parser = sax.parser(true, {
  html5: true,
  trim: true,
  normalize: true,
  lowercase: true
});
const tagstack = [];

function debounce(callback, ctxt) {
  return function wrapper() {
    if (!wrapper._called) {
      wrapper._called = async(function() {
        wrapper._called = false;
        callback.call(ctxt);
      });
    }
  };
}

const isEvent = /^:(.*)/;

class EventHandler {
  constructor(handler) {
    this.handler = handler;
    this.listener = this.listener.bind(this);
  }

  listener(event) {
    this.caller(this.handler.events[event.type], event);
  }

  caller(spec, event) {
    if (!spec) { return; }
    let eventName;
    switch (typeof spec) {
      case 'function':
        spec.call(event.delegateTarget || event.currentTarget, event);
      break;
      case 'string':
        if (this.handler[spec]) {
          this.handler[spec](event);
        }
        else if (eventName = isEvent.exec(spec)) {
          this.handler.trigger(eventName[1], event);
        }
        else {
          throw new Error('Method "' + spec + '" not found');
        }
      break;
      case 'object':
        if (Array.isArray(spec)) {
          spec.forEach(s => this.caller(s, event));
        }
        else {
          for (let selector in spec) {
            // Find all matching elements
            const matches = event.currentTarget.querySelectorAll(selector);

            // If event.target is, or is a child of matching element
            let found = this.find(matches, event.target);
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

  find(matches, target) {
    for (let match of matches) {
      // Is the target itself or contains the target
      if (match === target || match.contains(target)) {
        return match;
      }
    }
  }

  hook(node) {
    for (let event in this.handler.events) {
      node.addEventListener(event, this.listener, false);
    }
  }

  unhook(node) {
    for (let event in this.handler.events) {
      node.removeEventListener(event, this.listener, false);
    }
  }
}

let tree, handler;

extend(_parser, {
  onopentag({ name, attributes }) {
    if (name.toLowerCase() === 'svg') {
      _parser.svg = true;
    }

    const tag = { name, attributes, children: [], svg: _parser.svg };
    transform(tag);

    if (tagstack[tagstack.length - 1]) {
      tagstack[tagstack.length - 1].children.push(tag);
    }
    else if (handler && handler.events) {
      tag.properties['event-mappable'] = new EventHandler(handler);
    }
    tagstack.push(tag);
  },
  onclosetag() {
    const tag = tagstack.pop();

    // switch to svg() when in svg mode
    let vnode = (tag.svg ? svg : h)(tag.name, tag.properties, tag.children);

    if (tag.name.toLowerCase() === 'svg') {
      _parser.svg = false;
    }
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

export default View.extend({
  init(...args) {
    this._super(...args);
    if (this._model.on) {
      this.listenTo(this._model, 'all', debounce(this.render, this));
    }

    this.on({
      prerender() {
        handler = this;
      },
      postrender() {
        handler = null;
      }
    });
  }
}, {
  domify(html) {
    tree = null;
    _parser.write(html).close();
    return tree;
  },

  appendTo(tree, $context) {
    tree._el = createElement(tree);
    return View.appendTo(tree._el, $context);
  },

  replace(oldtree, newtree) {
    const p = diff(oldtree, newtree);
    if (newtree) {
      newtree._el = oldtree._el;
    }
    patch(oldtree._el, p);
  },

  find($root, selector) {
    if (!selector) {
      return $root._el || $root;
    }
    return View.find($root._el || $root, selector);
  },

  remove(tree) {
    this.replace(tree);
  }
});
