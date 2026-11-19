// Шим монтирования: plugin.js импортируется свежим на каждый монтаж
// (cache-busting по времени), поэтому правка логики применяется
// переключением бандла @local/dsh-topic-bridge — без рестарта dsh-web.
const impl = await import(`./plugin.js?v=${Date.now()}`);
export const name = impl.name;
export const inject = impl.inject;
export const apply = impl.apply;
