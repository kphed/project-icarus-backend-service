const WebSocket = require('ws');

const connectedClients = [];

// Broadcast incoming notifications to connected clients
const broadcastEvent = (channel, data) => (
  connectedClients.forEach((client) => {
    // Only send if the client is available
    if (client.readyState === WebSocket.OPEN) {
      client.send(JSON.stringify({
        channel,
        data,
      }));
    }
  })
);

const handleNotifications = async (data, db, { logger }) => {
  const {
    channel,
    payload,
  } = data;

  switch (channel) {
    case 'txCreated':
      try {
        const res = await db.query('SELECT * FROM txs WHERE hash = $1', [payload]);

        if (res && res.rowCount) {
          broadcastEvent(channel, res.rows[0]);
        }
      } catch (err) {
        logger.error('Encountered an error while handling a db notification', err);
      }

      break;
    default:
      break;
  }
};

// Add connections to list for broadcasting messages (and processing, later, if needed)
const manageConnections = ws => connectedClients.push(ws);

module.exports = {
  manageConnections,
  handleNotifications,
};
