const path = require('path');
const express = require('express');
const session = require('express-session');
const pgSession = require('connect-pg-simple')(session);

const config = require('./config');
const pool = require('./db');
const { requireAuth } = require('./middleware/requireAuth');
const authRoutes = require('./routes/auth').router;
const vworldProxyRoutes = require('./routes/vworldProxy');
const parcelsRoutes = require('./routes/parcels');
const filesRoutes = require('./routes/files');
const cctvRoutes = require('./routes/cctv');
const routeFilesRoutes = require('./routes/routeFiles');
const sectionsRoutes = require('./routes/sections');
const roadIssuesRoutes = require('./routes/roadIssues');
const bulkImportRoutes = require('./routes/bulkImport');
const auditLogRoutes = require('./routes/auditLog');

const app = express();

app.use(express.json());
app.use(
    session({
        store: new pgSession({ pool, tableName: 'session' }),
        secret: config.sessionSecret,
        resave: false,
        saveUninitialized: false,
        cookie: { maxAge: config.sessionMaxAgeHours * 60 * 60 * 1000 },
    })
);

app.use('/api/auth', authRoutes);
app.use('/api/vworld', requireAuth, vworldProxyRoutes);
app.use('/api/cctv', requireAuth, cctvRoutes);
app.use('/api/parcels', parcelsRoutes);
app.use('/api/parcels', filesRoutes);
app.use('/api/routes/files', routeFilesRoutes);
app.use('/api/sections', sectionsRoutes);
app.use('/api/road-issues', roadIssuesRoutes);
app.use('/api/bulk-import', bulkImportRoutes);
app.use('/api/audit-log', auditLogRoutes);

const staticDir = path.join(__dirname, '..', config.serveDir);
app.use(express.static(staticDir));

app.listen(config.port, () => {
    console.log(`도로대장 시스템 서버 실행 중: http://localhost:${config.port} (정적 파일: ${config.serveDir}/)`);
});
