import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import semver from 'semver';
import {
  always,
  apply,
  complement,
  cond,
  curry,
  equals,
  has,
  is,
  identity,
  map,
  mergeRight,
  pipe,
  propEq,
  T,
} from 'ramda';
import RefParser from '@apidevtools/json-schema-ref-parser';
import template from 'uritemplate';
import qs from 'qs';

// This is probably not the best way to check for this?
const encodeBase64 = globalThis.btoa
  ? globalThis.btoa
  : (globalThis.Buffer ? (d) => globalThis.Buffer.from(d).toString('base64') : identity);

const METHODS = new Set(['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace']);
const IGNORED_HEADERS = new Set(['accept', 'content-type', 'authorization']);
// Technically OpenAPI does not want us to put body on delete, but we'll allow it anyway...
const CAN_HAVE_BODY = new Set(['put', 'post', 'delete', 'patch']);

const memoize = (fn, map = new Map) => (arg) => {
  if (map.has(arg)) { return map.get(arg); }
  const value = fn(arg);
  map.set(arg, value);
  return value;
};

const pathParameter = (values) => (path, parameter) => {
  const {
    name,
    style = 'simple',
    explode = false,
  } = parameter;
  const prefix = cond([
    [equals('matrix'), always(';')],
    [equals('label'), always('.')],
    [T, always('')],
  ])(style);
  const suffix = explode ? '*' : '';
  const expansion = template
    .parse(`{${prefix}${name}${suffix}}`)
    .expand(values);
  return path.replaceAll(`{${name}}`, expansion);
};

const queryParameter = (values) => (parameter) => {
  const {
    name,
    style = 'form',
    explode = style === 'form',
    allowReserved = false,
    allowEmptyValue = false,
  } = parameter;

  const value = values[name];

  if (style === 'deepObject') {
    return qs.stringify({ [name]: value }, { encode: !allowReserved });
  }

  const encode = allowReserved ? identity : encodeURIComponent;
  if (Array.isArray(value)) {
    if (explode) {
      return value.map(`${encodeURIComponent(name)}=${encode(value)}`);
    } else {
      const delimiter = cond([
        [equals('spaceDelimited'), always('%20')],
        [equals('pipeDelimited'), always('|')],
        [T, always(',')],
      ])(style);
      return `${encodeURIComponent(name)}=${value.map(encode).join(delimiter)}`;
    }
  } else if (value && typeof value === 'object') {
    // NOTE: it does not seem to be defined what to do in the case that the property values
    // of an object are not primitive values. Continuing that trend, I have not defined and
    // don't know what will happen if such an object reaches this point.
    if (explode) {
      return Object
        .entries(value)
        .map(([key, value]) => [encodeURIComponent(key), encode(value)].join('='));
    } else {
      const encoded = Object
        .entries(value)
        .flatMap(([key, value]) => [encode(key), encode(value)])
        .join(',');
      return `${encodeURIComponent(name)}=${encoded}`;
    }
  }

  if (value === null || value === undefined) {
    if (allowEmptyValue) {
      return `${encodeURIComponent(name)}=`;
    } else {
      return;
    }
  }

  return `${encodeURIComponent(name)}=${encode(value)}`;
};

const headerParameter = (values) => (headers, parameter) => {
  const { name, explode = false } = parameter;
  const suffix = explode ? '*' : '';
  const expansion = template
    .parse(`{${name}${suffix}}`)
    .expand(values);
  headers.set(name, expansion);
  return headers;
};

const satisfiesSecurityScheme = (securitySchemes, credentials) => (name) => {
  const scheme = securitySchemes[name];
  switch (scheme.type) {
    case 'http':
      if (!(name in credentials)) { return false; }
      switch (scheme.scheme.toLowerCase()) {
        case 'basic': return 'user' in credentials[name] && 'pass' in credentials[name];
        case 'bearer': return true;
        default:
          // TODO: only Basic and Bearer are officially implemented, others we just assume the
          // caller has done it correctly somehow.
          return true;
      }
    case 'apiKey':
      // cannot reliably check cookies because they should have been set HTTP Only
      if (scheme.in === 'cookie') { return true; }
      /* fallsthrough */
    case 'oauth2':
    case 'openIdConnect':
      return name in credentials;
  }
};

const invoker = (context) => (method, operation) => {
  const {
    operationId,
    parameters = [],
    requestBody: unresolvedRequestBody,
    security = context.security,
    deprecated = false,
  } = operation;

  const unresolvedParameters = [...context.parameters, ...parameters];

  const invoke = (params, options = {}) => async (env) => {
    const allParameters = await context.dereference(unresolvedParameters);
    const requestBody = await context.dereference(unresolvedRequestBody);
    if (context.log) {
      if (deprecated) {
        context.log.warn(`Invoking deprecated operation ${operationId}`);
      }
      for (const parameter of allParameters) {
        if (parameter.in === 'cookie') {
          continue;
        }
        const { name } = parameter;
        if (parameter.required && !(name in params)) {
          context.log.warn(`Missing required parameter ${name} to ${operationId}`)
          continue;
        }
        const schema = await context.dereference(parameter.content
          ? Object.values(parameter.content)[0].schema
          : parameter.schema);
        if (schema && !context.ajv.validate(schema, params[name])) {
          context.log.warn(`Value provided for ${name} to ${operationId} does not satisfy the expected schema`);
        }
      }
    }

    // TODO: Parameters with a `content` property, instead of using schema and style, are not
    // supported in any particular way... but they probably should be?

    const path = allParameters
      .filter(propEq('in', 'path'))
      .reduce(pathParameter(params), context.path);
    const url = (env.url || context.url) + path; // OpenAPI specifies that these should be appended
    url.search = allParameters
      .filter(propEq('in', 'query'))
      .flatMap(queryParameter(params))
      .join('&');

    const headers = allParameters
      .filter(propEq('in', 'header'))
      .filter(_ => !IGNORED_HEADERS.has(_.name.toLowerCase()))
      .reduce(headerParameter(params), new Headers(options.headers));

    let body = options.body;
    checkBody: if (CAN_HAVE_BODY.has(method) && requestBody) {
      const { content, required } = requestBody;
      if (required && !options.body) {
        if (context.log) {
          context.log.warn(`Missing required request body for ${operationId}`);
        }
        break checkBody;
      }
      let contentType = headers.get('Content-Type');
      if (!contentType && Object.keys(content).length === 1) {
        contentType = Object.keys(content)[0];
      }
      if (!contentType) {
        if (context.log) {
          context.log.warn(`Could not determine Content-Type for ${operationId}`);
        }
        break checkBody;
      }
      headers.set('Content-Type', contentType);
      if (!(contentType in content)) {
        if (context.log) {
          context.log.warn(`Unsupported Content-Type ${contentType} for ${operationId}`);
        }
      }
      if (contentType === 'application/json') {
        const { schema } = content[contentType];
        if (context.log && !context.ajv.validate(schema, body)) {
          context.log.warn(`Provided JSON request body does not match schema for ${operationId}`);
        }
        body = JSON.stringify(body);
      }
    }

    checkSecurity: if (security.length) {
      const securitySchemes = await context.dereference(context.securitySchemes);
      const { credentials = {} } = env;
      for (const requirement of security) {
        const allSatisfied = Object
          .keys(requirement)
          .every(satisfiesSecurityScheme(securitySchemes, credentials));
        if (allSatisfied) {
          for (const schemeName of Object.keys(requirement)) {
            const scheme = securitySchemes[schemeName];
            switch (scheme.type) {
              case 'apiKey': {
                const { name } = scheme;
                switch (scheme.in) {
                  case 'cookie': continue;
                  case 'header': headers.set(name, credentials[schemeName]); break;
                  case 'query': url.searchParams.append(name, credentials[schemeName]); break;
                }
                break;
              }
              case 'http':
                switch (scheme.scheme.toLowerCase()) {
                  case 'bearer': headers.set('Authorization', `Bearer ${credentials[schemeName]}`); break;
                  case 'basic': {
                    const { user, pass } = credentials[schemeName];
                    headers.set('Authorization', `Basic ${encodeBase64(`${user}:${pass}`)}`);
                    break;
                  }
                  default: headers.set('Authorization', credentials[schemeName]); break;
                }
                break;
              case 'oauth2':
              case 'openIdConnect':
                // NOTE: we have assumed that if OAuth2 is used, the token is expected in the
                // Authorization header. OAuth2 does not actually specify where it belongs, this
                // is up to the implementing server, so this is a bit sketchy to assume.
                headers.set('Authorization', `Bearer ${credentials[schemeName]}`);
                break;
            }
          }
          break checkSecurity;
        }
      }
      if (context.log) {
        context.log.warn(`No required set of security schemes was satisfied for ${operationId}`);
      }
    }

    return (env.fetch || context.fetch)(url, {
      ...options,
      method: method.toUpperCase(),
      headers,
      body,
    });
  };
  return { [operationId]: invoke };
};

const invokers = (context) => (path, pathItem) => {
  const { parameters = [] } = pathItem;
  return Object
    .entries(pathItem)
    .filter(([method]) => METHODS.has(method))
    .map(apply(invoker({ ...context, path, parameters })));
};

export const create = (spec, { url, logging, fetch: fetch_ = fetch, console: console_ = console } = {}) => {
  if (!spec?.openapi) {
    throw new TypeError('Invalid OpenAPI spec object');
  }

  const {
    openapi,
    info,
    paths,
    components: { securitySchemes = [] } = {},
    security = [],
  } = spec;
  if (!semver.satisfies(openapi, '^3.0.0')) {
    throw new TypeError(`Unsupported openapi version ${openapi}`);
  }

  const warn = (message) => console_.warn(`OpenAPI (${info.title}@${info.version}): ${message}`);

  const ajv = new Ajv;
  addFormats(ajv);

  const $refs = RefParser.resolve(spec);
  const dereference = memoize(cond([
    [complement(is(Object)), identity],
    [Array.isArray, pipe(map((value) => dereference(value)), (promises) => Promise.all(promises))],
    [has('$ref'), ({ $ref }) => $refs.then((refs) => dereference(refs.get($ref)))],
    [T, async (object) => {
      const entries = Object
        .entries(object)
        .map(async ([key, value]) => [key, await dereference(value)])
      return Object.fromEntries(await Promise.all(entries));
    }],
  ]));

  const context = {
    dereference,
    url,
    securitySchemes,
    security,
    ajv,
    fetch: fetch_,
    log: logging ? { warn } : null,
  };

  return Object
    .entries(paths)
    .flatMap(apply(invokers(context)))
    .reduce(mergeRight, {});
};

export const hosted = async (url, opts = {}) => {
  const { fetch: fetch_ = fetch } = opts;
  return fetch_(url)
    .then(_ => _.json())
    .then(_ => create(_, { url, ...opts }));
};

export const client = curry((env, invocation) => invocation(env));
