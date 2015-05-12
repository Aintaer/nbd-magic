vdom=virtual-dom/

all: dist virtual-dom

virtual-dom:
	./node_modules/.bin/r.js -convert node_modules/virtual-dom/ dist/$(vdom)

dist: Magic.js
	mkdir -p dist
	./node_modules/.bin/babel $< -o $@/$< -m amd

clean:
	rm -r dist/
