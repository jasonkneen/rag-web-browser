import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { Actor } from 'apify';
import { log } from 'crawlee';
import express, { Request, Response } from 'express';

import { Routes } from './const.js';
import { createAndStartCrawlers } from './crawlers.js';
import { processInput } from './input.js';
import { RagWebBrowserServer } from './mcp/server.js';
import { addTimeoutToAllResponses } from './responses.js';
import { handleSearchRequest, handleSearchNormalMode } from './search.js';
import { Input } from './types.js';

await Actor.init();

Actor.on('migrating', () => {
    addTimeoutToAllResponses(60);
});

const app = express();

const mcpServer = new RagWebBrowserServer();
let transport: SSEServerTransport;

const HELP_MESSAGE = `Send a GET request to ${process.env.ACTOR_STANDBY_URL}/search?query=hello+world`
        + ` or to ${process.env.ACTOR_STANDBY_URL}/messages to use Model context protocol.`;

app.get('/', async (req, res) => {
    log.info(`Received GET message at: ${req.url}`);
    res.status(200).json({ message: `Actor is running in Standby mode. ${HELP_MESSAGE}` });
});

app.get(Routes.SEARCH, async (req: Request, res: Response) => {
    log.info(`Received GET message at: ${req.url}`);
    await handleSearchRequest(req, res);
});

app.head(Routes.SEARCH, async (req: Request, res: Response) => {
    log.info(`Received HEAD message at: ${req.url}`);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end();
});

app.get(Routes.SSE, async (req: Request, res: Response) => {
    log.info(`Received GET message at: ${req.url}`);
    transport = new SSEServerTransport(Routes.MESSAGE, res);
    await mcpServer.connect(transport);
});

app.post(Routes.MESSAGE, async (req: Request, res: Response) => {
    log.info(`Received POST message at: ${req.url}`);
    await transport.handlePostMessage(req, res);
});

// Catch-all for undefined routes
app.use((req, res) => {
    res.status(404).json({ message: `The is nothing at route ${req.method} ${req.originalUrl}. ${HELP_MESSAGE}` });
});

const standbyMode = Actor.getEnv().metaOrigin === 'STANDBY';
const rawInput = (await Actor.getInput<Partial<Input>>()) ?? ({} as Input);
let { input, searchCrawlerOptions, contentCrawlerOptions, contentScraperSettings } = await processInput(
    rawInput,
    standbyMode,
);

log.info(`Loaded input: ${JSON.stringify(input)},
    cheerioCrawlerOptions: ${JSON.stringify(searchCrawlerOptions)},
    contentCrawlerOptions: ${JSON.stringify(contentCrawlerOptions)},
    contentScraperSettings ${JSON.stringify(contentScraperSettings)}
`);

if (standbyMode) {
    log.info('Actor is running in the STANDBY mode.');

    const host = Actor.isAtHome() ? process.env.ACTOR_STANDBY_URL : 'http://localhost';
    const port = Actor.isAtHome() ? process.env.ACTOR_STANDBY_PORT : 3000;
    app.listen(port, async () => {
        // Pre-create default crawlers
        log.info(`The Actor web server is listening for user requests at ${host}:${port}`);
        await createAndStartCrawlers(
            searchCrawlerOptions,
            contentCrawlerOptions,
            input.useCheerioCrawler,
        );

        rawInput.useCheerioCrawler = !rawInput.useCheerioCrawler;
        ({ input, searchCrawlerOptions, contentCrawlerOptions, contentScraperSettings } = await processInput(
            rawInput,
            standbyMode,
        ));
        // Pre-create the other content crawler
        await createAndStartCrawlers(
            searchCrawlerOptions,
            contentCrawlerOptions,
            input.useCheerioCrawler,
        );
    });
} else {
    log.info('Actor is running in the NORMAL mode.');
    try {
        await handleSearchNormalMode(input, searchCrawlerOptions, contentCrawlerOptions, contentScraperSettings);
    } catch (e) {
        const error = e as Error;
        await Actor.fail(error.message as string);
    }
    await Actor.exit();
}
