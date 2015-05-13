const propMap = {
  id: 'id',
  name: 'name',
  class: 'className',
  title: 'title',
  value: 'value',
  tabindex: 'tabIndex'
};

function transformAttributes(attributes) {
  const properties = {};
  properties.attributes = attributes;

  for (let prop in attributes) {
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
  tag.properties = transformAttributes(tag.attributes);
  delete tag.attributes;
}

export default transformTag;
