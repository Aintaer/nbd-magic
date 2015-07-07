module.exports = {
  output: {
    path: __dirname + '/dist',
    libraryTarget: 'umd'
  },
  target: 'web',
  module: {
    loaders: [{
      test: /src\/.*\.js$/,
      loader: 'babel'
    }]
  },
  externals: [/^nbd\//]
};
