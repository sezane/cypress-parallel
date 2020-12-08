#!/usr/bin/env node
const Table = require('cli-table');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const yargs = require('yargs');
const { isYarn } = require('is-npm');

const WEIGHTS_JSON = 'cypress/parallel-weights.json';

const argv = yargs
  .option('script', {
    alias: 's',
    type: 'string',
    description: 'Your npm Cypress command'
  })
  .option('threads', {
    alias: 't',
    type: 'number',
    description: 'Number of threads'
  })
  .option('specsDir', {
    alias: 'd',
    type: 'string',
    description: 'Cypress specs directory'
  })
  .option('args', {
    alias: 'a',
    type: 'string',
    description: 'Your npm Cypress command arguments'
  })
  .option('writeWeightFile', {
      alias: 'w',
      type: 'boolean',
      description: `Write ${WEIGHTS_JSON} file ? `
  }).argv;

const CY_SCRIPT = argv.script;
if (!CY_SCRIPT) {
  throw new Error('Expected command, e.g.: cypress-parallel <cypress-script>');
}

let N_THREADS = argv.threads ? argv.threads : 2;
const SPEC_FILES_PATH = argv.specsDir ? argv.specsDir : 'cypress/integration';
const WRITE_WEIGHTS_FILE = argv.writeWeightFile ? argv.writeWeightFile : false;
const CY_SCRIPT_ARGS = argv.args ? argv.args.split(' ') : [];

const COLORS = [
  '\x1b[32m',
  '\x1b[36m',
  '\x1b[29m',
  '\x1b[33m',
  '\x1b[37m',
  '\x1b[38m',
  '\x1b[39m',
  '\x1b[40m'
];

const getAllFiles = dir =>
  fs.readdirSync(dir).reduce((files, file) => {
    const name = path.join(dir, file);
    const isDirectory = fs.statSync(name).isDirectory();
    if (isDirectory) return [...files, ...getAllFiles(name)];
    return [...files, name];
  }, []);

const logger = function(c) {
  const color = c;
  return function(message) {
    console.log(`${color}${message}`);
  };
};

const getRandomInt = function (max) {
  return Math.floor(Math.random() * Math.floor(max));
};

// function stolen from: https://stackoverflow.com/a/32180863/7329
const formatTime = function(millisec) {
  var seconds = (millisec / 1000).toFixed(1);
  var minutes = (millisec / (1000 * 60)).toFixed(1);
  var hours = (millisec / (1000 * 60 * 60)).toFixed(1);
  var days = (millisec / (1000 * 60 * 60 * 24)).toFixed(1);

  if (seconds < 60) {
      return seconds + " Sec";
  } else if (minutes < 60) {
      return minutes + " Min";
  } else if (hours < 24) {
      return hours + " Hrs";
  } else {
      return days + " Days"
  }
};

const start = () => {
  const startRunTime = new Date().getTime()
  const fileList = getAllFiles(SPEC_FILES_PATH);
  let specWeights = {};
  try {
    specWeights = JSON.parse(fs.readFileSync(WEIGHTS_JSON, 'utf8'));
  } catch (err) {
    console.log(`Weight file not found in path: ${WEIGHTS_JSON}`);
  }

  console.log(`Preparing to run ${fileList.length} spec files.  Please wait, the first result may take a bit of time to appear.`)

  let map = new Map();
  for (let f of fileList) {
    let specWeight = getRandomInt(3);
    Object.keys(specWeights).forEach(spec => {
      if (f.endsWith(spec)) {
        specWeight = specWeights[spec].weight;
      }
    });
    map.set(f, specWeight);
  }

  map = new Map([...map.entries()].sort((a, b) => b[1] - a[1]));

  // Reduce useless number of threads
  if (N_THREADS > fileList.length) {
    N_THREADS /= 2;
  }
  const weigths = [];
  for (let i = 0; i < N_THREADS; i++) {
    weigths.push({
      weight: 0,
      list: []
    });
  }

  for (const [key, value] of map.entries()) {
    weigths.sort((w1, w2) => w1.weight - w2.weight);
    weigths[0].list.push(key);
    weigths[0].weight += +value;
  }
  const commands = weigths.map((w, i) => ({
    color: COLORS[i],
    tests: `'${w.list.join(',')}'`
  }));

  const children = [];
  commands.forEach(command => {
    const promise = new Promise((resolve, reject) => {
      const timeMap = new Map();
      let suiteDuration = 0;

      const pckManager = isYarn
        ? 'yarn'
        : process.platform === 'win32'
          ? 'npm.cmd'
          : 'npm';
      const child = spawn(pckManager, [
        'run',
        `${CY_SCRIPT}`,
        '--',
        '--reporter',
        'cypress-parallel/json-stream.reporter.js',
        '--spec',
        command.tests,
        ...CY_SCRIPT_ARGS
      ]);

      child.stdout.on('data', data => {
        try {
          const test = JSON.parse(data);
          if (test[0] === 'pass') {
            suiteDuration = test[1].duration;
            console.log(
              `\x1b[32m✔ \x1b[0m${test[1].title} (${suiteDuration}ms)`
            );
          }
          if (test[0] === 'fail') {
            suiteDuration = test[1].duration;
            console.log(`\x1b[31m✖ \x1b[0m${test[1].title} (${suiteDuration}ms)`);
            console.log(`\x1b[31m${test[1].err}`);
            console.log(`\x1b[31m${test[1].stack}`);
          }
          if (test[0] === 'suiteEnd' && test[1].title != null) {
            timeMap.set(test[1].title, { ...test[1], duration: suiteDuration });
          }
        } catch (error) {
          // No error logs
        }
      });
      child.stderr.on('data', data => {
        // only for debug purpose
        console.log('\x1b[31m', `${data}`);
      });

      child.on('exit', () => {
        resolve(timeMap);
      });
    });
    children.push(promise);
  });

  let timeMap = new Map();
  let threadTimes = []
  Promise.all(children).then(resultMaps => {
    resultMaps.forEach((m, t) => {
      let totTimeThread = 0;
      for (let [name, test] of m) {
        totTimeThread += test.duration;
      }
      console.log(`Thread ${t} time: ${formatTime(totTimeThread)}`);
      threadTimes.push(totTimeThread)

      timeMap = new Map([...timeMap, ...m]);
    });

    let table = new Table({
      head: ['Spec', 'Time', 'Tests', 'Passing', 'Failing', 'Pending'],
      style: { head: ['green'] },
      colWidths: [45, 25, 7, 9, 9, 9]
    });

    let totalTests = 0;
    let totalPasses = 0;
    let totalDuration = 0;
    let totalPending = 0;

    let totalWeight = timeMap.size * 10;
    let specWeights = {};
    for (let [name, test] of timeMap) {
      totalDuration += test.duration;
      totalTests += test.tests;
      totalPasses += test.passes;
      totalPending += totalPending;
      specWeights[name] = { time: test.duration, weight: 0 };
      table.push([
        name,
        `${formatTime(test.duration)}`,
        test.tests,
        test.passes,
        test.failures,
        test.pending
      ]);
    }

    if (WRITE_WEIGHTS_FILE) {
      Object.keys(specWeights).forEach(spec => {
      specWeights[spec].weight = Math.floor(
        (specWeights[spec].time / totalDuration) * totalWeight
      );
      });

      const weightsJson = JSON.stringify(specWeights);

      fs.writeFile(`${WEIGHTS_JSON}`, weightsJson, 'utf8', err => {
        if (err) throw err;
        console.log('Generated file parallel-weights.json.');
      });
    }

    const endRunTime = new Date().getTime()
    const totalRunTime = endRunTime - startRunTime


    table.push([
      'Total Run Time and Final Results',
      `${formatTime(totalRunTime)}`,
      totalTests,
      totalPasses,
      totalTests-totalPasses,
      totalPending
    ]);

    console.log(table.toString());
  });
};

start();
