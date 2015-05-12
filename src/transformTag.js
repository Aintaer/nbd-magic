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

function transformTag(tag) {
  transformAttributes(tag.attributes);
}

export default transformTag;
