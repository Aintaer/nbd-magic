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

const _parser = sax.parser({
  html5: true,
  trim: true,
  normalize: true,
  lowercase: true
});
const tagstack = [];

const blocking = '__debounced__'; // Symbol('debounced');

function debounce(fn) {
	if (fn[blocking]) { return; }
	const retval = fn.call(this);
	fn[blocking] = true;
	async(() => delete fn[blocking]);
	return retval;
}

let tree;

extend(_parser, {
	onopentag({ name, attributes }) {
		const tag = { name, attributes, children: [] };
		transform(tag);

		if (tagstack[tagstack.length - 1]) {
			tagstack[tagstack.length - 1].children.push(tag);
		}
		tagstack.push(tag);
	},
	onclosetag() {
		const tag = tagstack.pop();

        // TODO: switch to svg() when in svg mode
		let vnode = h(tag.name, tag.attributes, tag.children);
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
			this.listenTo(this._model, 'all', () => debounce.call(this, this.render));
		}
	},

	template(data) {
		return this.mustache && this.mustache(data, this.partials);
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
		patch(newtree._el = oldtree._el, p);
	},

	find($root, selector) {
		return View.find($root._el || $root, selector);
	},

	remove($el) {
		return View.remove($el._el || $el);
	}
});
