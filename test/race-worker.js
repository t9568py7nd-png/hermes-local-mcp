import { addNote } from '../src/store.js';

const [workerId, count] = process.argv.slice(2);
for (let i = 0; i < Number(count); i += 1) {
  addNote({ text: `worker-${workerId}-note-${i}`, tags: [`w${workerId}`] });
}
console.log(`added ${count}`);
