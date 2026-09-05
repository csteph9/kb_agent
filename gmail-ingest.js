// Compatibility entry point. Migrate once with: node ingest/cli.js migrate-gmail
process.argv = [process.argv[0], process.argv[1], 'run', process.env.GMAIL_SOURCE_ID || 'personal-gmail'];
await import('./ingest/cli.js');
