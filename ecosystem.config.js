// ecosystem.config.js — PM2 process config
// Usage: pm2 start ecosystem.config.js
module.exports = {
  apps: [
    {
      name:        'dht-app',
      script:      'server.js',
      cwd:         '/home/DHT/dht-app',
      instances:   1,
      autorestart: true,
      watch:       false,
      max_memory_restart: '300M',
      env: {
        NODE_ENV: 'production',
        PORT:     3001,
      },
    },
  ],
};
