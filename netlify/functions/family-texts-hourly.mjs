// Hourly (Netlify Scheduled Function): sends family texts scheduled for later, and any the CRM couldn't send right
// away (for example ones written after 9pm, which wait until 8am). See family-texts.mjs.
import { run } from './family-texts.mjs';

export const config = { schedule: '@hourly' };

export default async () => {
  const result = await run(process.env, fetch, console.log, { budgetMs: 20000 });
  return new Response(JSON.stringify(result), { headers: { 'content-type': 'application/json' } });
};
