// PM2 ecosystem config
// Claude CLI refuses --dangerously-skip-permissions when running as root.
// On root servers, start PM2 as non-root user:
//   su - aiclaw -s /bin/bash -c 'cd /root/web_www/ai-claw && pm2 start ecosystem.config.cjs'
module.exports = {
  apps: [
    {
      name: "ai-claw",
      script: "dist/index.js",
      exec_mode: "fork",
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
