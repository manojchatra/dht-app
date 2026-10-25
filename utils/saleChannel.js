// utils/saleChannel.js — where a contract was sold: a showroom (default) or a
// booth at Costco / Walmart / another event. Stored in the contract data as
// saleChannel { channel, location }. The store choice is unaffected — it still
// drives the contract number, tax, PDF header and review link.
'use strict';

const CHANNELS = { showroom: 'Showroom', costco: 'Costco', walmart: 'Walmart', event: 'Other event' };

// Form input → { channel, location } (unknown channel → showroom; location only for booths).
function cleanSaleChannel(sc) {
  const channel = CHANNELS[sc && sc.channel] ? sc.channel : 'showroom';
  const location = channel === 'showroom' ? '' : String((sc && sc.location) || '').trim().slice(0, 60);
  return { channel, location };
}

// "Showroom", "Costco", "Costco – Gilbert", "Other event – State Fair".
function saleChannelLabel(sc) {
  const { channel, location } = cleanSaleChannel(sc);
  return CHANNELS[channel] + (location ? ' – ' + location : '');
}

const isBoothSale = sc => cleanSaleChannel(sc).channel !== 'showroom';

module.exports = { CHANNELS, cleanSaleChannel, saleChannelLabel, isBoothSale };
