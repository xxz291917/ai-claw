// PM2 ecosystem config
// When running as root, automatically drops to 'aiclaw' user
// (required by Claude provider which refuses root execution)
const isRoot = process.getuid?.() === 0;

module.exports = {
  apps: [
    {
      name: "ai-claw",
      script: "dist/index.js",
      ...(isRoot && { uid: "aiclaw", gid: "aiclaw" }),
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
