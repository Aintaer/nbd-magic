vdom=virtual-dom/

all: dist virtual-dom

dist: Magic.js sax.js

%.js: src/%.js
	./node_modules/.bin/babel $< -o $@ -m amd

virtual-dom:
	./node_modules/.bin/r.js -convert node_modules/virtual-dom/ $(vdom)

clean:
	rm -r dist/
