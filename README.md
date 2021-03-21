# OpenFetch

Fetch-like OpenAPI client library. Supports [OpenAPI 3](https://swagger.io/specification/) only.

## Usage

```js
import * as openfetch from 'openfetch';

// Build an API based on the spec. You probably won't use this method directly, but the options
// are the same for the other methods. Shown below are the defaults:
const api = openfetch.create(SPEC, {
  // The base URL from which to make requests.
  url,
  // Enable logging. Validation errors will be logged to the console.
  logging: false,
  // The console, providing the log methods (only `warn` is used).
  console: window.console,
  // The default implementation of fetch to use for making requests.
  fetch: window.fetch,
});

// If your spec contains references (internal or external), they must be resolved.
// This is probably the situation for most specs.
const api = await openfetch.resolveAndCreate(SPEC, {
  // The URL where the spec is hosted, from which to resolve relative references.
  url,
  // The fetch implementation to use to make requests to resolve references.
  fetch: window.fetch,
  // ... also accepts the same opts as above
});

// If your spec is hosted, it can be retrieved automatically. In this case, the `url`
// passed here will automatically be set as the base URL for resolving references.
const api = await openfetch.hosted('http://example.com', {
 // ... same opts as above
});

// Create an invocation context with credentials and such. The keys of the credentials
// object are names of security schemes, and the values are their values...
// *   HTTP Basic Auth expects the value to be `{ user, pass }`
// *   HTTP Bearer Auth expects the value to be just the token (i.e. not including the "Bearer" prefix)
// *   Other HTTP auth expects the full header value (i.e. including the scheme name)
// *   OAuth2 will pass the token via Autorization header
const invoke = openfetch.client({
  // Override the base URL from which to make requests
  url,
  // Override the implementation of `fetch` again. This value takes precedence over the one
  // passed to `create`, if both were provided.
  fetch,
  // The credentials to use to satisfy security requirements
  credentials: {},
});

// Invoke an operation by `operationId` (here: `getUser`):
// *   Parameter are supplied by name
// *   Options are the same as fetch, with a few being supplied automatically:
//     *   `Content-Type` will be determined automatically if the spec only defines one request body
//         type, otherwise it must be supplied via `headers`.
//     *   If `Content-Type` is JSON, `body` will be passed through `JSON.stringify`.
//         No processing will be done to any other bodies.
//     *   The `Authorization` header will be set automatically based on the security requirements.
//     *   Set the `Accept` header manually to specify which response format to receive.
const response = await invoke(api.getUser({ id: 'foxfriends' }, { headers, body }));

// The response is whatever is returned by the provided implementation of `fetch`. Refer to the
// relevant documentation on how to handle that response. In particular:
// *   The response body is not interpreted at all (e.g. JSON is not parsed automatically)
// *   The response status is not interpreted at all (e.g. 4XX/5XX reponses do not throw)
console.assert(response instanceof Response)
```

Points to note:
*   This package assumes your OpenAPI spec is valid/correct, and that you are (for the most part)
    calling it with sensible values. Undefined behaviour will occur if you deviate from spec.
*   The `servers` field of the spec is ignored. Provide a correct `url` on your own.
*   There is currently no support for any extensions, but to be able to implement those as plugins
    is something that is being considered.

## Testing

So far... very little testing has been done. Just a bit of manual stuff. Trust this project at your
own risk for now, until I feel like writing a proper test suite.

## Contributing

Contributions are welcome! Please send a PR or create issues if you would like something improved.
