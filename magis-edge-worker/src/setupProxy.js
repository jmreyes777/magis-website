// src/setupProxy.js
const { createProxyMiddleware } = require("http-proxy-middleware");

module.exports = function(app) {
  // only proxy API & socket routes
  app.use(
    ["/api", "/socket.io"],
    createProxyMiddleware({
      target: "http://127.0.0.1:8787",
      changeOrigin: true,
      ws: true,     // proxy websockets
    })
  );
};
