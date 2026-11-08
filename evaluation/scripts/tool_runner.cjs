const tools = require(process.argv[2]);
const name = process.argv[3];
let args;
try {
  args = JSON.parse(process.argv[4]);
  const out = tools.execute(name, args);
  console.log(JSON.stringify({ ok: true, out }));
} catch (error) {
  console.log(JSON.stringify({ ok: false, error: error.message }));
}
