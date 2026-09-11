// A separate short-lived client; it neither imports JobService nor owns the worker.
fetch(`http://127.0.0.1:${process.argv[2]}/jobs`, { method: 'POST' })
  .then(response => response.json())
  .then(job => { process.stdout.write(JSON.stringify(job)); })
  .catch(error => { console.error(error); process.exitCode = 1; });
