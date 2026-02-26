module.exports = {
  apps: [
    {
      name: "ai-claw",
      script: "dist/index.js",
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: "1024M",
      env: {
        NODE_ENV: "production",
      },
    },
  ],
};
