import semver from 'semver';
import { always, apply, cond, curry, equals, identity, mergeRight, propEq, T } from 'ramda';
import { parse as resolve } from 'jsonref';
import template from 'uritemplate';
import qs from 'qs';

// This is probably not the best way to check for this?
const encodeBase64 = btoa ? btoa : (Buffer ? (d) => Buffer.from(d).toString('base64') : identity);

const METHODS = new Set(['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace']);
const IGNORED_HEADERS = new Set(['accept', 'content-type', 'authorization']);
// Technically OpenAPI does not want us to put body on delete, but we'll allow it anyway...
const CAN_HAVE_BODY = new Set(['put', 'post', 'delete', 'patch']);
const FORM_TYPES = new Set(['application/x-www-form-urlencoded', 'multipart/form-data']);

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
    .parse(`{${name}*}`)
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
    case 'oauth2':
    case 'openIdConnect':
      return name in credentials;
  }
};

const invoker = (context) => (method, operation) => {
  const {
    operationId,
    parameters = [],
    requestBody,
    security = context.security,
    responses,
    deprecated = false,
  } = operation;

  const allParameters = [...context.parameters, ...parameters];

  const invoke = (params, options) => async (env) => {
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
        const schema = parameter.content
          ? Object.values(parameter.content)[0].schema
          : parameter.schema;
        if (schema && !Ajv.validate(parameter.schema, params[name])) {
          context.log.warn(`Value provided for ${name} to ${operationId} does not satisfy the expected schema`);
        }
      }
    }

    // TODO: Parameters with a `content` property, instead of using schema and style, are not
    // supported in any particular way... but they probably should be?

    const path = allParameters
      .filter(propEq('in', 'path'))
      .reduce(pathParameter(params), context.path);
    const url = new URL(path, context.url);
    url.search = allParameters
      .filter(propEq('in', 'query'))
      .flatMap(queryParameter(params))
      .join('&');

    const setHeader = (headers, { name }) => (headers.set(name, params[name]), headers);
    const headers = allParameters
      .filter(propEq('in', 'header'))
      .filter(_ => !IGNORED_HEADERS.has(_.name.toLowerCase()))
      .reduce(headerParameter(params), new Headers(options.headers));

    let body = options.body;
    checkBody: if (CAN_HAVE_BODY.has(method) && requestBody) {
      const { content, required } = requestBody;
      const {
        contentType = Object.keys(content).length === 1
          ? Object.keys(content)[0]
          : undefined,
      } = options;
      if (context.log) {
        if (required && !options.body) {
          context.log.warn(`Missing required request body for ${operationId}`);
          break checkBody;
        }
        if (!contentType) {
          context.log.warn(`Could not determine Content-Type for ${operationId}`);
          break checkBody;
        }
      }

      headers.set('Content-Type', contentType);
      if (context.log) {
        if (!(contentType in content) && context.log) {
          context.log.warn(`Unsupported Content-Type ${contentType} for ${operationId}`);
          break checkBody;
        }
      }

      const { schema } = content[contentType];
      if (contentType === 'application/json') {
        if (context.log && !Ajv.validate(schema, body)) {
          context.log.warn(`Provided JSON request body does not match schema for ${operationId}`);
        }
        body = JSON.stringify(body);
      }
    }

    checkSecurity: if (security.length) {
      const { securitySchemes } = context;
      const { credentials = {} } = env;
      for (const requirement of security) {
        const allSatisfied = Object
          .keys(requirement)
          .every(satisfiesSecurityScheme(securitySchemes, credentials));
        if (allSatisfied) {
          for (const schemeName of Object.keys(requirement)) {
            const scheme = securitySchemes[schemeName];
            switch (scheme.type) {
              case 'apiKey':
                const { name } = scheme;
                switch (scheme.in) {
                  case 'cookie': continue;
                  case 'header': headers.set(name, credentials[schemeName]); break;
                  case 'query': url.searchParams.append(name, credentials[schemeName]); break;
                }
                break;
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

    return context.fetch(url, {
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

export const create = (spec, { url, logging, fetch = fetch, console = console } = {}) => {
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

  const warn = (message) => console.warn(`OpenAPI (${info.title}@${info.version}): ${message}`);

  const context = {
    url,
    components,
    securitySchemes,
    security,
    fetch,
    log: logging ? { warn } : null,
  };

  return Object
    .entries(paths)
    .flatMap(apply(invokers(context)))
    .reduce(mergeRight, {});
};

export const resolveAndCreate = async (document, opts = {}) => {
  const { fetch = fetch } = opts;
  return resolve(doc, { retriever: (url) => fetch(url).then(_ => _.json()) })
    .then(_ => create(_, { url, ...opts }));
};

export const hosted = async (url, opts = {}) => {
  const { fetch = fetch } = opts;
  return fetch(url)
    .then(_ => _.json())
    .then(_ => resolveAndCreate(_, { url, ...opts }));
};

export const fetch = curry((env, invocation) => invocation(env));
