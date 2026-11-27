process.removeAllListeners('warning');
process.on('warning', (warning) => {
  if (warning.name === 'ExperimentalWarning') return;
  console.warn(`[warning] ${warning.name}: ${warning.message}`);
});