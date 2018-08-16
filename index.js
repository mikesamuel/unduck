/**
 * @license
 * Copyright 2018 Google LLC
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     https://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

'use strict';

/* eslint id-length: ["error", { "exceptions": ["i", "n", "x"] }] */

const { isArray } = Array;
const {
  assign,
  getOwnPropertyNames,
  getOwnPropertySymbols,
  getPrototypeOf,
  setPrototypeOf,
} = Object;

const hasOwn = Function.prototype.call.bind(Object.hasOwnProperty);

const objProto = getPrototypeOf({});

/** A breadcrumb used to identify object graph cycles. */
const IN_PROGRESS_BREADCRUMB = {};

/**
 * Thrown when there is a problem inferring a class type for
 * a bag of properties or converting the bag to constructor arguments.
 */
class DuckError extends TypeError {
  constructor(...args) {
    super(...args);
    this.name = this.constructor.name;
  }
}

/**
 * Thrown when there is no applicable rule.
 */
class MissingDuckError extends DuckError {
}


/**
 * A mapping from bags of properties to class instances.
 *
 * @param {boolean} trusted true iff x comes from a trusted source.
 * @param {DTree} root to search for applicable duck types.
 * @param {*} userContext a user supplied context value that is forwarded to all
 *     toConstructorArguments calls.
 */
function processor(trusted, root, userContext) {
  // used to detect object graph cycles and avoid multiply unducking
  // the same value.
  const unduckingMap = new Map();
  // Sentinel value.
  const notApplicable = {};

  /**
   * Produces a class type instance given a bag of properties.
   * @param {*} x the bag.
   */
  function process(x) {
    if (!x || typeof x !== 'object') {
      // Functions do not end up getting properties recursively deducked.
      return x;
    }

    // Don't muck with class instances.
    // We treat anything that has a null prototype, a prototype that is an
    // object, or a prototype that (like Objects from other realms) has a
    // null prototype.
    let xIsArray = false;
    const proto = getPrototypeOf(x);
    if (proto && proto !== objProto && getPrototypeOf(proto) !== null &&
        !(xIsArray = isArray(x))) {
      return x;
    }

    // Handle non-tree-like object-graphs including cycles.
    if (unduckingMap.has(x)) {
      const processed = unduckingMap.get(x);
      if (processed === IN_PROGRESS_BREADCRUMB) {
        throw new DuckError('Duck hunt cycle');
      }
      return processed;
    }
    unduckingMap.set(x, IN_PROGRESS_BREADCRUMB);

    let result = null;
    if (xIsArray) {
      // eslint-disable-next-line no-use-before-define
      result = processArray(x);
    } else {
      // eslint-disable-next-line no-use-before-define
      result = processPojo(x);
    }
    unduckingMap.set(x, result);
    return result;
  }

  /**
   * @param duckType the type to attempt to apply
   * @param unchained the properties in the bag without a null prototype.
   * @param report null or a function that takes a duckType and an error.
   *    Null means no-op.
   * @param failFast true to propagate errors up aggressively since there
   *    is no failover.
   * @return null on failure, or an argument suitable for toConstructorArguments.
   */
  function applyOneDuckType(duckType, unchained, report, failFast) {
    const scratchSpace = assign(setPrototypeOf({}, null), unchained);
    const { properties, requiredKeys } = duckType;
    // Check that all properties are allowed.
    for (const key in scratchSpace) {
      if (!(key in properties)) {
        if (report) {
          report(
            duckType,
            new MissingDuckError(
              `Duck type ${ duckType.classType.name } does not allow key ${ key }`));
        }
        return null;
      }
    }
    for (let i = 0, n = requiredKeys.length; i < n; ++i) {
      const key = requiredKeys[i];
      if (!(key in scratchSpace)) {
        if (report) {
          report(
            duckType,
            new MissingDuckError(
              `Input does not have key ${
                key } required by duck type ${ duckType.classType.nam }`));
        }
        return null;
      }
    }
    // required values enforced in convert.  TODO: maybe reconsider this

    // Compute recursive field values before trying to convert to
    // constructor arguments.
    const { recurseToKeys } = duckType;
    for (let i = 0, n = recurseToKeys.length; i < n; ++i) {
      const recKey = recurseToKeys[i];
      if (recKey in scratchSpace) {
        try {
          // unduckingMap doubles as a memo-table so we will not multiply
          // evaluate.
          scratchSpace[recKey] = process(scratchSpace[recKey]);
        } catch (exc) {
          if (!failFast && exc instanceof MissingDuckError) {
            // The eventual match may not care about this.
            if (report) {
              report(duckType, exc);
            }
            return null;
          }
          throw exc;
        }
      }
    }

    // Apply defaults.
    // We could do this after convertKeys, but a default looks like
    // a property bag value, so if converters map from property bag
    // values to construcor inputs, then applying defaults before
    // converters is more consistent with the principal of least surprise.
    const { defaultKeys } = duckType;
    for (let i = 0, n = defaultKeys.length; i < n; ++i) {
      const key = defaultKeys[i];
      if (!(key in scratchSpace)) {
        scratchSpace[key] = duckType.properties[defaultKeys].default;
      }
    }

    // Apply converters for properties.
    const { convertKeys } = duckType;
    for (let i = 0, n = convertKeys.length; i < n; ++i) {
      const key = convertKeys[i];
      if (key in scratchSpace) {
        const { convert } = properties[key];
        const converted = convert(
          scratchSpace[key], trusted, userContext, notApplicable);
        if (converted === notApplicable) {
          if (report) {
            report(
              duckType,
              new MissingDuckError(
                `Failed to convert property ${ key } using type ${
                  duckType.classType.name }`));
          }
          return null;
        }
        scratchSpace[key] = converted;
      }
    }

    return scratchSpace;
  }

  /**
   * Once we have a candidate set of applicable types, figure out which
   * is applicable, and what arguments to use for its constructor.
   * @param {!DTree} node
   * @param {!Object} unchained bag with same property values as the input but no prototype.
   * @param {boolean} collectErrorTrace true to generate a nice error message.
   */
  function tentativelyApplyDuckTypes(node, unchained, collectErrorTrace) {
    let applicableDuckType = null;
    let applicableConstructorArgs = null;

    // Produce error messages in line if there is only one to try which
    // should be a common case.
    const failFast = node.count === 1;

    let report = null;
    // If we eventually find an applicable type, consider these water
    // under the duck.
    let suppressedErrors = null;
    if (failFast || collectErrorTrace) {
      report = (duckType, failure) => {
        if (failFast) {
          throw failure;
        }
        suppressedErrors.push(duckType, failure);
      };
      if (!failFast) {
        suppressedErrors = [];
      }
    }

    // We need to rollback changes to unchained if there are multiple
    // competing types.
    for (const duckType of node.types()) {
      const scratchSpace = applyOneDuckType(duckType, unchained, report, failFast);
      if (!scratchSpace) {
        continue;
      }
      const { toConstructorArguments } = duckType;

      // Now that we've all the properties we need and they've been converted.
      // turn them into constructor arguments.
      const args = toConstructorArguments(scratchSpace, trusted, userContext);
      if (isArray(args)) {
        if (applicableDuckType) {
          throw new DuckError(
            `Duck hunt found multiple applicable types: ${
              applicableDuckType.classType.name
            } and ${ duckType.classType.name }`);
        }
        applicableDuckType = duckType;
        applicableConstructorArgs = args;
      } else if (report) {
        report(duckType,
          new MissingDuckError(
            `Failed to compute constructor arguments for ${ duckType.classType.name }`));
      }
    }
    let errorMessage = null;
    if (!applicableDuckType && collectErrorTrace) {
      if (suppressedErrors.length) {
        errorMessage = [];
        for (let i = 0, n = suppressedErrors.length; i < n; i += 2) {
          errorMessage.push(`${ suppressedErrors[i].classType.name }: ${ suppressedErrors[i + 1] }`);
        }
        errorMessage = errorMessage.join('\n');
      } else if (!node.count) {
        errorMessage = 'No types matching';
      }
    }
    return { applicableConstructorArgs, applicableDuckType, errorMessage };
  }

  /** For arrays, we recursively process everything. */
  function processArray(x) {
    // We create a this-realm array.
    const result = [];

    for (let stringKeys = getOwnPropertyNames(x),
      i = 0, n = stringKeys.length;
      i < n; ++i) {
      // TODO: is for(...in...) loop more efficient for long arrays?
      // TODO: do we even care about holes and non-index keys?
      const key = stringKeys[i];
      if (key !== '__proto__' && key !== 'length') {
        // TODO: might setting length fill in holes.  If not, can skip check.
        result[key] = process(x[key]);
      }
    }
    for (let symbolKeys = getOwnPropertySymbols(x),
      i = 0, n = symbolKeys.length;
      i < n; ++i) {
      const key = symbolKeys[i];
      result[key] = process(x[key]);
    }
    return result;
  }

  /** Find an applicable type for an object and apply it. */
  function processPojo(x) {
    // Use a temporary object so we don't multiply read fields.
    const unchained = setPrototypeOf({}, null);
    for (let stringKeys = getOwnPropertyNames(x),
      i = 0, n = stringKeys.length;
      i < n; ++i) {
      const key = stringKeys[i];
      if (key !== '__proto__') {
        // HACK: could fall back to Object.defineProperty
        // when key === '__proto__'
        unchained[key] = x[key];
      }
    }
    for (let symbolKeys = getOwnPropertySymbols(x),
      i = 0, n = symbolKeys.length;
      i < n; ++i) {
      const key = symbolKeys[i];
      unchained[key] = x[key];
    }

    const node = root.duckHunt(unchained);
    const { applicableConstructorArgs, applicableDuckType } =
      // Try without collecting error trace.
      tentativelyApplyDuckTypes(node, unchained, false);
    if (!applicableConstructorArgs) {
      // TODO: map node.types() to type names.
      // TODO: use suppressed errors.
      throw new MissingDuckError({
        errorMessage: null,
        toString() {
          if (this.errorMessage === null) {
            // Redo with the extra work to collect error trace.
            const { errorMessage } = tentativelyApplyDuckTypes(
              node, unchained, true);
            this.errorMessage = errorMessage ||
              `Failed to compute constructor arguments for [${
                Array.from(node.types()).map((duckType) => duckType.classType.name)
              }]`;
          }
          return this.errorMessage;
        },
      });
    }
    const ClassType = applicableDuckType.classType;
    return new ClassType(...applicableConstructorArgs);
  }

  return process; // eslint-disable-line no-use-before-define
}


function keysForTypes(duckTypes) {
  const required = new Set();
  const optionalOnly = new Set();

  for (let i = 0, n = duckTypes.length; i < n; ++i) {
    const { properties } = duckTypes[i];
    function addKey(key) { // eslint-disable-line no-inner-declarations
      (properties[key].required ? required : optionalOnly).add(key);
    }
    getOwnPropertyNames(properties).forEach(addKey);
    getOwnPropertySymbols(properties).forEach(addKey);
  }
  const keys = new Set(optionalOnly);
  for (const key of required) {
    optionalOnly.delete(key);
    keys.add(key);
  }
  return [ keys, optionalOnly ];
}

function entropyAfterPartitions(partitionLengths) {
  let numerator = 0;
  let denominator = 0;
  for (const n of partitionLengths) {
    if (n) {
      numerator += n * Math.log2(n);
      denominator += n;
    }
  }
  return denominator ? numerator / denominator : Infinity;
}

/**
 * Find a key required by one or more types.
 */
function partitionOnRequiredKey(duckTypes, keys) {
  const count = duckTypes.length;

  let minEntropyAfter = Infinity;
  let bestPartitionKey = null;
  let bestPartition = null;

  /**
   * Try key to see if partitioning on it is better than the
   * next best alternative found thus far.
   */
  function tryPartition(key) {
    let valueMap = null;
    const haveWithoutSpecialValue = [];
    const haveNot = [];
    for (let i = 0; i < count; ++i) {
      const duckType = duckTypes[i];
      const { properties } = duckType;
      if (key in properties) {
        const propertyDescriptor = properties[key];
        if ('value' in propertyDescriptor) {
          const requiredValue = propertyDescriptor.value;
          if (!valueMap) {
            valueMap = new Map();
          }
          if (!valueMap.has(requiredValue)) {
            valueMap.set(requiredValue, []);
          }
          valueMap.get(requiredValue).push(duckType);
        } else {
          haveWithoutSpecialValue.push(duckType);
        }
        if (!propertyDescriptor.required) {
          haveNot.push(duckType);
        }
      } else {
        haveNot.push(duckType);
      }
    }

    if (haveNot.length === count && haveWithoutSpecialValue.length === count) {
      return;
    }

    const partitionSizes = [ haveNot.length, haveWithoutSpecialValue.length ];
    if (valueMap) {
      for (const [ , types ] of valueMap) {
        partitionSizes.push(types.length + haveWithoutSpecialValue.length);
      }
    }
    const entropyAfter = entropyAfterPartitions(partitionSizes);

    if (entropyAfter < minEntropyAfter) {
      minEntropyAfter = entropyAfter;
      bestPartitionKey = key;
      bestPartition = { haveNot, haveWithoutSpecialValue, valueMap };
    }
  }
  // Find the highest information value partition.
  keys.forEach(tryPartition);

  return {
    entropyAfter: minEntropyAfter,
    partitionKey: bestPartitionKey,
    partition: bestPartition,
  };
}

/**
 * Group types based on which optional keys they may have.
 */
function partitionOnOptionalKeys(duckTypes, keys) {
  const count = duckTypes.length;
  const partitionSizes = [];
  const keyPartitionMap = new Map();

  for (const key of keys) {
    const mayHave = [];
    for (const duckType of duckTypes) {
      if (key in duckType.properties) {
        mayHave.push(duckType);
      }
    }
    if (mayHave.length <= count / 2) {
      keyPartitionMap.set(key, mayHave);
      partitionSizes.push(mayHave.length);
    }
  }

  if (keyPartitionMap.size === 0) {
    return { entropyAfter: Infinity };
  }

  // If we find no keys, that doesn't mean we don't have to still look.
  partitionSizes.push(count);
  const entropyAfter = entropyAfterPartitions(partitionSizes);

  return { entropyAfter, keyPartitionMap };
}


class DTree {
  constructor(duckTypes, used, parent) {
    this.parent = parent;
    this.count = duckTypes.length;
    this.key = null;
    this.duckTypes = null;
    this.haveNot = null;
    this.have = null;
    this.valueMap = null;
    this.mayHaveMap = null;
    this.haveNone = null;

    const [ keys, optionalOnly ] = keysForTypes(duckTypes);
    const unused = new Set(keys);
    const optionalOnlyUnused = new Set(optionalOnly);
    for (const key of used) {
      unused.delete(key);
      optionalOnlyUnused.delete(key);
    }

    const count = duckTypes.length;
    if (count <= 1) {
      this.duckTypes = duckTypes;
      return;
    }

    // First try finding a must-have parition by looking at required keys.
    // eslint-disable-next-line prefer-const
    let { entropyAfter: reqEntropyAfter, partitionKey, partition } =
      partitionOnRequiredKey(duckTypes, unused);

    // Next see if looking at a may-have partition.
    // eslint-disable-next-line prefer-const
    let { entropyAfter: optEntropyAfter, keyPartitionMap } =
      partitionOnOptionalKeys(duckTypes, optionalOnlyUnused);

    // For an N-way classifier, the entropy is
    //   H(X) = -(sum from i=1..n, p(xi) * log p(xi)
    // so since we are trying to classify each duckType separately,
    // the entropy before is
    //   count * -(1/count) * log(1/count)
    // but log(1/count) = -log(count) so
    const entropyBefore = Math.log2(count);

    const reqInformationGain = entropyBefore - reqEntropyAfter;
    const optInformationGain = entropyBefore - optEntropyAfter;
    if (keyPartitionMap && reqInformationGain < optInformationGain) {
      partition = null;
    } else if (partition) {
      keyPartitionMap = null;
    }

    if (partition) {
      const { haveNot, haveWithoutSpecialValue, valueMap } = partition;
      used.add(partitionKey);
      this.key = partitionKey;
      this.haveNot = new DTree(haveNot, used, this);
      this.have = new DTree(haveWithoutSpecialValue, used, this);
      if (valueMap) {
        this.valueMap = new Map();
        for (const [ k, ts ] of valueMap) {
          this.valueMap.set(
            k, new DTree(ts.concat(haveWithoutSpecialValue), used, this));
        }
      }
      used.delete(partitionKey);
    } else if (keyPartitionMap) {
      this.mayHaveMap = new Map();
      const newUsed = new Set(used);
      for (const [ key ] of keyPartitionMap) {
        newUsed.add(key);
      }
      for (const [ key, types ] of keyPartitionMap) {
        this.mayHaveMap.set(key, new DTree(types, newUsed, this));
      }
      this.haveNone = new DTree(duckTypes, newUsed, this);
    } else {
      // this is a leaf node and hunt falls back to linear search.
      this.duckTypes = duckTypes;
    }
  }

  types() {
    return (this.duckTypes || [])[Symbol.iterator]();
  }

  /**
   * Finds the leaf node most applicable to x.
   */
  duckHunt(x) {
    // Loop from unrolling tail calls.
    // eslint-disable-next-line consistent-this
    for (let node = this; true;) { // eslint-disable-line no-constant-condition
      // Return if we reached a leaf.
      if (node.duckTypes) {
        return node;
      }

      const { mayHaveMap } = node;
      if (mayHaveMap) {
        node = node.haveNone;
        for (const key in x) {
          const next = mayHaveMap.get(key);
          if (next) {
            node = next;
            break;
          }
        }
      } else {
        const { key } = node;
        if (key in x) {
          const { valueMap } = node;
          // Unless the specific value indicates otherwise.
          node = node.have;
          if (valueMap) {
            const value = x[key];
            if (valueMap && valueMap.has(value)) {
              node = valueMap.get(value);
            }
          }
        } else {
          node = node.haveNot;
        }
      }
      if (!node.count) {
        throw new MissingDuckError({
          toString() {
            return node.diagnostic(x);
          },
        });
      }
    }
  }

  diagnostic(x) {
    const checked = [];
    // eslint-disable-next-line consistent-this
    for (let node = this; node; node = node.parent) {
      if (node.key) {
        checked.push(node.key);
      }
    }
    checked.reverse();
    const available = [ ...getOwnPropertyNames(x), ...getOwnPropertySymbols(x) ];
    return `Could not find duck type for\n  [${
      checked }]\ngiven value with properties\n  [${
      available }]`;
  }

  toJSON() {
    const obj = { count: this.count };
    if (this.duckTypes) {
      obj.duckTypes = this.duckTypes.map((typ) => typ.classType.name);
    }
    if (this.key !== null) {
      obj.key = this.key;
    }
    if (this.have) {
      obj.have = this.have.toJSON();
    }
    if (this.haveNot) {
      obj.haveNot = this.haveNot.toJSON();
    }
    if (this.valueMap) {
      obj.valueMap = {};
      for (const [ key, value ] of this.valueMap) {
        obj.valueMap[key] = value.toJSON();
      }
    }
    if (this.mayHaveMap) {
      obj.mayHaveMap = {};
      for (const [ key, value ] of this.mayHaveMap) {
        obj.mayHaveMap[key] = value.toJSON();
      }
    }
    if (this.haveNone) {
      obj.haveNone = this.haveNone.toJSON();
    }
    return obj;
  }
}

/**
 * Maker for a function that converts duck type descriptions into
 * objects that are internally useful.
 *
 * The metadata maker defensively copies,
 * removes `in`/`hasOwnProperty` ambiguity,
 * and stores useful derived data.
 *
 * @return a function from duck type descriptions to internal
 *    records that returns a reference identical version given
 *    the same input description.  Since it caches, mutations to
 *    the input will not affect the internal version.
 */
function duckTypeMetadataMaker() {
  const metadataMap = new Map();
  return function makeMetadata(duckType) {
    if (!(hasOwn(duckType, 'classType') &&
          typeof duckType.classType === 'function')) {
      throw new Error('Duck type missing .classType');
    }
    if (!(hasOwn(duckType, 'properties') &&
          typeof duckType.properties === 'object' &&
          duckType.properties)) {
      throw new Error('Duck type missing .properties');
    }
    if (!(hasOwn(duckType, 'toConstructorArguments') &&
          typeof duckType.toConstructorArguments === 'function')) {
      throw new Error('Duck type missing .toConstructorArguments');
    }

    if (metadataMap.has(duckType)) {
      return metadataMap.get(duckType);
    }
    const { properties: rawProperties, toConstructorArguments, classType } =
        duckType;

    const properties = {};
    setPrototypeOf(properties, null);

    const requiredKeys = [];
    const defaultKeys = [];
    const convertKeys = [];
    const recurseToKeys = [];

    // Unpack a property descriptor.
    // eslint-disable-next-line complexity
    function makePropertyMetadata(key) {
      if (key === '__proto__') {
        throw new Error(
          '__proto__ has a special meaning that is incompatible with POJOs');
      }
      const rawProperty = rawProperties[key];
      const property = {};
      setPrototypeOf(property, null);
      properties[key] = property;

      const hasDefault = hasOwn(rawProperty, 'default');
      const defaultValue = hasDefault ? rawProperty.default : null;
      if (hasDefault) {
        defaultKeys.push(key);
        property.default = defaultValue;
      }

      property.required = hasOwn(rawProperty, 'required') ?
        rawProperty.required === true :
        !hasDefault;
      if (property.required) {
        requiredKeys.push(key);
      }

      if (hasOwn(rawProperty, 'value')) {
        property.value = rawProperty.value;
      }

      if (hasOwn(rawProperty, 'recurse') ?
        rawProperty.recurse === true :
        // Do not recurse by default to fields with mandated values.
        !hasOwn(rawProperty, 'value')) {
        recurseToKeys.push(key);
      }

      let rawConvert = hasOwn(rawProperty, 'convert') ?
        rawProperty.convert : null;
      if (typeof rawConvert !== 'function') {
        rawConvert = null;
      }

      const hasInnocuous = hasOwn(rawProperty, 'innocuous');
      const requireTrusted = hasOwn(rawProperty, 'trusted') ?
        rawProperty.trusted === true :
        hasInnocuous;

      let type = hasOwn(rawProperty, 'type') ?
        rawProperty.type : null;
      if (typeof type !== 'string' && typeof type !== 'function') {
        type = null;
      }

      const requiresValue = hasOwn(rawProperty, 'value');
      const requiredValue = requiresValue && rawProperty.value;

      const innocuous = hasInnocuous ?
        rawProperty.innocuous : defaultValue;

      if (requireTrusted || type || requiresValue) {
        property.convert = function convert(value, trusted, userContext, notApplicable) {
          if (requiresValue) {
            // TODO: NaN
            if (requiredValue !== value) {
              return notApplicable;
            }
          } else if (type) {
            switch (typeof type) {
              case 'string':
                if (type !== typeof value) {
                  return notApplicable;
                }
                break;
              case 'function':
                // TODO: substitute Array for isArray, etc.
                if (!(value && value instanceof type)) {
                  return notApplicable;
                }
                break;
              default:
            }
          }
          const tvalue = requireTrusted && !trusted ? innocuous : value;
          return (rawConvert) ?
            rawConvert(tvalue, trusted, userContext, notApplicable) : tvalue;
        };
      } else if (rawConvert) {
        property.convert = rawConvert;
      }
      if (property.convert) {
        convertKeys.push(key);
      }
    }

    for (const keys of [ getOwnPropertyNames(rawProperties), getOwnPropertySymbols(rawProperties) ]) {
      keys.forEach(makePropertyMetadata);
    }

    const augmented = {
      classType,
      properties,
      toConstructorArguments,
      convertKeys,
      recurseToKeys,
      defaultKeys,
      requiredKeys,
    };

    metadataMap.set(duckType, augmented);
    return augmented;
  };
}

/**
 * Given a set of duck types creates a pond.
 * Ponds are callable and calling them with a bag
 * of properties hunts for the right duck type and
 * applies it.
 */
function makePond(duckTypes) {
  let root = null;
  const metadataMaker = duckTypeMetadataMaker();

  function getRoot() {
    if (!root) {
      // Dedupe and normalize.
      const duckTypesNorm = Array.from(new Set(duckTypes)).map(metadataMaker);

      root = new DTree(duckTypesNorm, new Set(), null);
    }
    return root;
  }

  function unducker(trusted) {
    return {
      // Create as an object property so this supports internal
      // operator [Call] but not [Construct].
      unduck(x, userContext) {
        return processor(trusted, getRoot(), userContext)(x);
      },
    }.unduck;
  }

  const pond = unducker(false);
  pond.trust = unducker(true);
  pond.withTypes =
    /**
     * Returns a duck pond with the types in pond
     * plus the given extra types.
     * Makes a best effort to fail fast on bad
     * type descriptions, but cannot prove that two
     * types don't conflict for all possible inputs.
     */
    function withTypes(...moreDuckTypes) {
      const duckTypeSet = new Set(duckTypes);
      // Get all our ducks in a row.
      for (const duckType of moreDuckTypes) {
        duckTypeSet.add(duckType);
        // Run checks and fail early.
        metadataMaker(duckType);
      }

      return makePond(Array.from(duckTypeSet));
    };
  // Used by tests to test partitioning isn't terrible.
  pond._diagnostic = function _diagnostic() {
    return getRoot().toJSON();
  };
  return pond;
}


// Start with an empty pond and let clients add to it with
// .withTypes(...).
module.exports.unduck = makePond([]);
module.DuckError = DuckError;
