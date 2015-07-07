all: dist

dist: dist/Magic.js

dist/Magic.js: src/Magic.js
	./node_modules/.bin/webpack -c $< $@

clean:
	rm -r dist/
