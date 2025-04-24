// utils/logger.js
const chalk = require('chalk'); // Using chalk v4 for CommonJS compatibility
const moment = require('moment'); // Using moment for timestamp formatting

// Basic logging functions
const log = (content, type = 'log') => {
  const timestamp = `[${moment().format('YYYY-MM-DD HH:mm:ss')}]`;
  switch (type) {
    case 'log': {
      // Use chalk methods directly on the imported object for v4
      return console.log(`${timestamp} ${chalk.blue(type.toUpperCase())} ${content} `);
    }
    case 'warn': {
      return console.log(`${timestamp} ${chalk.yellow(type.toUpperCase())} ${content} `);
    }
    case 'error': {
      const message = content instanceof Error ? content.stack || content.message : content;
      return console.log(`${timestamp} ${chalk.red(type.toUpperCase())} ${message} `);
    }
    case 'debug': {
       if (process.env.DEBUG_MODE === 'true') {
            // Correct usage for chalk v4
            return console.log(`${timestamp} ${chalk.green(type.toUpperCase())} ${content} `);
       }
       break;
    }
    case 'ready': {
      // Correct usage for chalk v4
      return console.log(`${timestamp} ${chalk.greenBright(type.toUpperCase())} ${content}`);
    }
    case 'info': {
         // Correct usage for chalk v4: chalk.cyan(...)
         return console.log(`${timestamp} ${chalk.cyan(type.toUpperCase())} ${content} `);
    }
    default: throw new TypeError('Logger type must be one of: log, warn, error, debug, ready, info.');
  }
};

module.exports = {
  log,
  info: (...args) => log(args.join(' '), 'info'),
  warn: (...args) => log(args.join(' '), 'warn'),
  error: (...args) => log(args.find(arg => arg instanceof Error) || args.join(' '), 'error'),
  debug: (...args) => log(args.join(' '), 'debug'),
  ready: (...args) => log(args.join(' '), 'ready'),
};
