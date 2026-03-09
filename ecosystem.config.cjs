// PM2 ecosystem config
// On root servers, start PM2 as non-root user to satisfy Claude CLI:
//   su - aiclaw -c 'cd /root/web_www/ai-claw && pm2 start ecosystem.config.cjs'
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
