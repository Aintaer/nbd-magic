all: dist

dist: transpile dist/Magic.js

dist/Magic.js: build.js 
	./node_modules/.bin/r.js -o $< out=$@

transpile: Magic.js sax.js transformTag.js virtual-dom

%.js: src/%.js
	./node_modules/.bin/babel $< -o $@ -m amd

virtual-dom: vdom-deps
	./node_modules/.bin/r.js -convert node_modules/virtual-dom/ virtual-dom/

vdom-deps:
	./node_modules/.bin/r.js -convert node_modules/virtual-dom/node_modules/ deps/

clean:
	rm -r dist/
