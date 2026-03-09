// PM2 ecosystem config
//
// IMPORTANT: Two requirements for running on root servers:
//
// 1. exec_mode MUST be "fork" — When uid/gid is set, PM2 silently switches
//    to "cluster" mode, which breaks ESM module resolution (e.g. Cannot find
//    package 'dotenv'). Always set exec_mode: "fork" explicitly.
//
// 2. uid/gid MUST be non-root — Claude CLI (Agent SDK) refuses to run with
//    --dangerously-skip-permissions under root/sudo. The uid/gid config
//    tells PM2 to drop privileges to 'aiclaw' user automatically.
//
// Together: root runs `pm2 start ecosystem.config.cjs`, PM2 forks the
// process as 'aiclaw' user in fork mode. No `su` needed.
const isRoot = process.getuid?.() === 0;

module.exports = {
  apps: [
    {
      name: "ai-claw",
      script: "dist/index.js",
      exec_mode: "fork",
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
