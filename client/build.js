// Генерирует config.js из переменной окружения BURA_SERVER_URL, заданной
// в настройках проекта на Vercel (Settings -> Environment Variables).
// Так адрес Railway-бэкенда не нужно каждый раз вбивать вручную на телефоне.
const fs = require('fs');
const path = require('path');

const url = process.env.BURA_SERVER_URL || '';
const content = `// Автосгенерировано при билде из переменной окружения BURA_SERVER_URL\nwindow.BURA_DEFAULT_SERVER = ${JSON.stringify(url)};\n`;

fs.writeFileSync(path.join(__dirname, 'config.js'), content);
console.log('config.js создан, BURA_DEFAULT_SERVER =', url || '(пусто)');
