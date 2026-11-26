'use strict';
const { createMonitorService } = require('../app/monitor');
createMonitorService().list().then(result => console.log(JSON.stringify(result, null, 2)))
  .catch(error => { console.error(error.message); process.exitCode = 1; });
