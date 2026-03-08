// PM2 ecosystem config
// NOTE: When CHAT_PROVIDER=claude on a root server, Claude CLI refuses
// --allow-dangerously-skip-permissions. Need to run as non-root user:
//   PM2_RUN_AS_USER=aiclaw pm2 start ecosystem.config.cjs --update-env
// See src/chat/claude-provider.ts for details.
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
