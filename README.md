# OpenFetch

Fetch-like OpenAPI client library.

Usage:

```js
import { client, hosted, external, create } from 'openfetch';

// Build an API based on the spec
const api = create(SPEC, { url: 'http://example.com' });

// If your spec contains references (internal or external), they must be resolved.
// This is probably the situation for most specs.
const api = await resolveAndCreate(SPEC, { url: 'http://example.com' });

// If your spec is hosted, it can be retrieved automatically.
const api = await hosted(SPEC, { url: 'http://example.com' });

// Create an invocation context with credentials and such. The keys of the credentials
// object are names of security schemes, and the values are their values...
// *   HTTP Basic Auth expects the value to be `{ user, pass }`
// *   HTTP Bearer Auth expects the value to be just the token (i.e. not including the "Bearer" prefix)
// *   Other HTTP auth expects the full header value (i.e. including the scheme name)
// *   OAuth2 will pass the token via Autorization header
const invoke = client({ credentials: {} });

// Invoke an operation by `operationId`:
// *   Parameter are supplied by name
// *   Options are the same as fetch
//     *   If Content-Type is JSON, `body` will be passed through `JSON.stringify`.
//         No other processing will be done to the body. Content-Type will be determined
//         automatically if the spec only defines one request body type, otherwise it must
//         be supplied using the `headers`.
//     *   The Authorization header will be set automatically based on the security requirements.
const response = await invoke(api.getUser({ id: 'foxfriends' }, { headers, body }));
```
