const runButton = document.querySelector('#run');
const summary = document.querySelector('#summary');
const results = document.querySelector('#results');

function wait(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function assertion(condition, message) {
  if (!condition) throw new Error(message);
}

function addResult(name, passed, detail) {
  const row = document.createElement('li');
  row.className = passed ? 'pass' : 'fail';
  row.textContent = `${passed ? 'PASS' : 'FAIL'} — ${name}: ${detail}`;
  results.append(row);
}

function sinePcm16(samples, rate = 24_000, frequency = 440) {
  const pcm = new Int16Array(samples);
  for (let index = 0; index < samples; index += 1) {
    pcm[index] = Math.round(Math.sin(2 * Math.PI * frequency * index / rate) * 10_000);
  }
  return pcm;
}

async function runCaptureTest(context) {
  const capture = new AudioWorkletNode(context, 'capture-processor', {
    numberOfInputs: 1,
    numberOfOutputs: 1,
    outputChannelCount: [1],
    channelCountMode: 'max'
  });
  const mute = context.createGain();
  mute.gain.value = 0;
  capture.connect(mute).connect(context.destination);
  const chunks = [];
  capture.port.onmessage = ({ data }) => {
    if (data?.type === 'PCM_CHUNK') chunks.push(new Int16Array(data.buffer));
  };

  const left = context.createOscillator();
  const right = context.createOscillator();
  left.frequency.value = 440;
  right.frequency.value = 880;
  const leftGain = context.createGain();
  const rightGain = context.createGain();
  leftGain.gain.value = 0.12;
  rightGain.gain.value = 0.08;
  const merger = context.createChannelMerger(2);
  left.connect(leftGain).connect(merger, 0, 0);
  right.connect(rightGain).connect(merger, 0, 1);
  merger.connect(capture);
  left.start();
  right.start();
  await wait(1200);
  left.stop();
  right.stop();
  merger.disconnect();
  capture.disconnect();
  mute.disconnect();

  assertion(chunks.length >= 6, `expected at least 6 chunks, received ${chunks.length}`);
  assertion(chunks.every((chunk) => chunk.length === 1600), 'capture emitted a non-1600-sample chunk');
  assertion(chunks.some((chunk) => chunk.some((sample) => Math.abs(sample) > 100)), 'captured PCM was silent');
  return `${chunks.length} exact 100 ms PCM16 chunks at 16 kHz`;
}

async function runPlaybackTest(context) {
  const playback = new AudioWorkletNode(context, 'playback-processor', {
    numberOfInputs: 0,
    numberOfOutputs: 1,
    outputChannelCount: [2]
  });
  const mute = context.createGain();
  mute.gain.value = 0;
  playback.connect(mute).connect(context.destination);
  const events = [];
  playback.port.onmessage = ({ data }) => events.push(data);

  for (let index = 0; index < 10; index += 1) {
    const pcm = sinePcm16(2400, 24_000, 440 + index);
    playback.port.postMessage({ type: 'ENQUEUE', buffer: pcm.buffer }, [pcm.buffer]);
  }
  await wait(2300);
  const active = events.find((event) => event.type === 'PLAYBACK_ACTIVE' && event.active === true);
  const inactive = events.find((event) => event.type === 'PLAYBACK_ACTIVE' && event.active === false);
  const status = [...events].reverse().find((event) => event.type === 'BUFFER_STATUS');
  assertion(active, 'playback never became active');
  assertion(inactive, 'playback did not return to inactive after draining');
  assertion(status?.underruns >= 1, 'expected a controlled underrun after synthetic stream ended');
  assertion(status?.targetBufferMs >= 160, 'adaptive target did not grow after underrun');
  playback.disconnect();
  mute.disconnect();
  return `activated, drained, and adapted target to ${status.targetBufferMs} ms`;
}

async function runBacklogTest(context) {
  const playback = new AudioWorkletNode(context, 'playback-processor', {
    numberOfInputs: 0,
    numberOfOutputs: 1,
    outputChannelCount: [2]
  });
  const mute = context.createGain();
  mute.gain.value = 0;
  playback.connect(mute).connect(context.destination);
  const events = [];
  playback.port.onmessage = ({ data }) => events.push(data);
  for (let index = 0; index < 70; index += 1) {
    const pcm = sinePcm16(2400);
    playback.port.postMessage({ type: 'ENQUEUE', buffer: pcm.buffer }, [pcm.buffer]);
  }
  await wait(1200);
  assertion(events.some((event) => event.type === 'BUFFER_RESET'), 'backlog reset was not emitted');
  const status = [...events].reverse().find((event) => event.type === 'BUFFER_STATUS');
  assertion(status?.bufferMs <= 1200, `stale backlog remained at ${status?.bufferMs} ms`);
  assertion(status?.targetBufferMs >= 300, 'backlog reset did not raise adaptive target');
  playback.port.postMessage({ type: 'CLEAR' });
  playback.disconnect();
  mute.disconnect();
  return `bounded stale output to ${status.bufferMs} ms with ${status.targetBufferMs} ms target`;
}

runButton.addEventListener('click', async () => {
  runButton.disabled = true;
  results.replaceChildren();
  summary.textContent = 'Running…';
  const context = new AudioContext({ latencyHint: 'interactive' });
  const tests = [
    ['Capture/downmix/resample/PCM16', runCaptureTest],
    ['Playback/resample/fade/adaptation', runPlaybackTest],
    ['Bounded backlog recovery', runBacklogTest]
  ];
  let passed = 0;
  try {
    await Promise.all([
      context.audioWorklet.addModule('/src/worklets/capture-processor.js'),
      context.audioWorklet.addModule('/src/worklets/playback-processor.js')
    ]);
    await context.resume();
    for (const [name, test] of tests) {
      try {
        const detail = await test(context);
        addResult(name, true, detail);
        passed += 1;
      } catch (error) {
        addResult(name, false, error.message);
      }
    }
  } catch (error) {
    addResult('Harness initialization', false, error.message);
  } finally {
    await context.close();
  }
  summary.textContent = `${passed}/${tests.length} browser audio integration tests passed`;
  summary.dataset.complete = 'true';
  runButton.disabled = false;
});
