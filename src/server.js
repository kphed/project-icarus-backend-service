// @flow
import type { Pool } from 'pg'; // eslint-disable-line
import type { DbApi } from 'icarus-backend'; // eslint-disable-line

const fs = require('fs');
const pathLib = require('path');
const restify = require('restify');
const WebSocket = require('ws');
const corsMiddleware = require('restify-cors-middleware');
const restifyBunyanLogger = require('restify-bunyan-logger');
const config = require('config');
const routes = require('./routes');
const createDB = require('./db');
const dbApi = require('./db-api');
const importerApi = require('./importer-api');
const configCleanup = require('./cleanup');
const {
  manageConnections,
  handleNotifications,
 } = require('./ws-connections');

const serverConfig = config.get('server');
const { logger, importerSendTxEndpoint } = serverConfig;

function addHttps(defaultRestifyConfig) {
  const TLS_DIR = pathLib.join(
    serverConfig.https.tlsDir,
    process.env.NODE_ENV ? process.env.NODE_ENV : '',
  );
  const httpsConfig = {
    certificate: fs.readFileSync(`${TLS_DIR}/server.crt`),
    key: fs.readFileSync(`${TLS_DIR}/server.key`),
    ca: fs.readFileSync(`${TLS_DIR}/ca.pem`),
  };
  return Object.assign({}, defaultRestifyConfig, httpsConfig);
}

async function setUpDb(db) {
  try {
    const client = await db.connect();

    // Remove existing "transaction created"-related triggers and functions
    await client.query('DROP TRIGGER IF EXISTS TxCreatedTrigger ON "txs"');
    await client.query('DROP FUNCTION IF EXISTS NotifyTxCreated()');

    // Add a function and trigger for executing logic when transactions are created
    await client.query("CREATE FUNCTION NotifyTxCreated() RETURNS trigger AS $BODY$ BEGIN PERFORM pg_notify(CAST('txCreated' AS text), CAST(NEW.hash AS text)); RETURN new; END; $BODY$ LANGUAGE 'plpgsql';");
    await client.query('CREATE TRIGGER TxCreatedTrigger AFTER INSERT ON "txs" FOR EACH ROW EXECUTE PROCEDURE NotifyTxCreated()');

    // Attach a listener for the "txCreated" notification
    await client.query('LISTEN "txCreated"');

    // Define the logic for handling notifications that we are listening to
    client.on('notification', data => handleNotifications(data, db, serverConfig));
  } catch (err) {
    logger.error('Encountered an error while setting up the db', err);
  }
}

async function createServer() {
  const db = await createDB(config.get('db'));

  logger.info('Connected to db');

  await setUpDb(db);

  const defaultRestifyConfig = {
    log: logger,
  };

  const restifyConfig = serverConfig.https
    ? addHttps(defaultRestifyConfig)
    : defaultRestifyConfig;

  const server = restify.createServer(restifyConfig);

  const cors = corsMiddleware({ origins: serverConfig.corsEnabledFor });
  server.pre(cors.preflight);
  server.use(cors.actual);
  server.use(restify.plugins.bodyParser());
  server.on('after', restifyBunyanLogger());

  Object.values(routes).forEach(({ method, path, handler }: any) => {
    server[method](path, async (req, res, next) => {
      try {
        const result = await handler(
          dbApi(db),
          serverConfig,
          importerApi(importerSendTxEndpoint),
        )(req);
        res.send(result);
        next();
      } catch (err) {
        next(err);
      }
    });
  });

  const wss = new WebSocket.Server({ server });

  wss.on('connection', manageConnections);

  configCleanup(db, logger);

  server.listen(serverConfig.port, () => {
    logger.info('%s listening at %s', server.name, server.url);
  });

  return server;
}

module.exports = createServer;
