// craco.config.js
const { InjectManifest } = require("workbox-webpack-plugin");
const path = require("path");

module.exports = {
  babel: {
    plugins: [
      process.env.NODE_ENV === "production"
        ? ["transform-remove-console", { exclude: ["error", "warn"] }]
        : null,
    ].filter(Boolean),
  },
  webpack: {
    configure: (webpackConfig) => {
      // 1️⃣ Ensure we’re using a valid stats object
      webpackConfig.stats = {
        preset: webpackConfig.stats?.preset || "normal",
      };

      // 2️⃣ Silently drop the "called multiple times" warning
      webpackConfig.ignoreWarnings = [
        (warning) =>
          warning.message &&
          warning.message.includes(
            "InjectManifest has been called multiple times"
          ),
      ];

      return webpackConfig;
    },
    plugins: [
      new InjectManifest({
        swSrc: path.resolve(__dirname, "public/sw.js"),
        swDest: "sw.js",
        maximumFileSizeToCacheInBytes: 5 * 1024 * 1024,
      }),
    ],
  },
};
