// utils/contractStatus.js — contract status names as the pages show them.
'use strict';

const STATUS_NAMES = { assigned: 'Assigned', tbo: 'To Be Ordered', order_placed: 'Order Placed', received: 'Received',
  scheduled: 'Scheduled', delivered: 'Delivered', cancelled: 'Cancelled' };

const statusName = s => STATUS_NAMES[s] || s;

module.exports = { STATUS_NAMES, statusName };
