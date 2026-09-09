// PM2 Windows 서비스 실행용 설정
// 서버에서: cd server && pm2 start ecosystem.config.js && pm2 save
// (pm2-windows-startup 을 한 번 설치/설정해두면 서버 재부팅 시 pm2가 자동 기동되고,
//  pm2가 저장된 프로세스 목록(save)을 그대로 되살림)
module.exports = {
    apps: [
        {
            name: 'road-ledger',
            script: 'index.js',
            cwd: __dirname,
            env: {
                NODE_ENV: 'production',
            },
            autorestart: true,
            max_restarts: 10,
            restart_delay: 3000,
            out_file: './logs/out.log',
            error_file: './logs/error.log',
            time: true,
        },
    ],
};
