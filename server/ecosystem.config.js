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
            // 앱이 직접 쓰는 날짜별 운영 로그는 logs/app-YYYY-MM-DD.log(lib/serverLog.js,
            // 보관기간 지나면 자동 삭제). 아래 두 파일은 PM2가 따로 쌓는 시작/종료·크래시
            // 출력이라 pm2-logrotate로 로테이션을 걸어야 한다(deploy/서버배포_가이드.txt 13번).
            out_file: './logs/out.log',
            error_file: './logs/error.log',
            time: true,
        },
    ],
};
