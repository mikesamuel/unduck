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
  setPrototypeOf,
} = Object;

const hasOwn = Function.prototype.call.bind(Object.hasOwnProperty);

/** A breadcrumb used to identify object graph cycles. */
const IN_PROGRESS_BREADCRUMB = {};

class DuckError extends TypeError {
  constructor(...args) {
    super(...args);
    this.name = this.constructor.name;
  }
}

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

  /**
   * Produces a class type instance given a bag of properties.
   * @param {*} x the bag.
   */
  function process(x) {
    if (!x || typeof x !== 'object') {
      // Functions do not end up getting properties recursively deducked.
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
    if (isArray(x)) {
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
   * Once we have a candidate set of applicable types, figure out which
   * is applicable, and what arguments to use for its constructor.
   * @param {!DTree} node
   * @param {!Object} unchained bag with same property values as the input but no prototype.
   * @param {boolean} collectErrorTrace true to generate a nice error message.
   */
  function tentativelyApplyDuckTypes(node, unchained, collectErrorTrace) {
    let applicableDuckType = null;
    let applicableConstructorArgs = null;
    const notApplicable = {};

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
    typeLoop:
    for (const duckType of node.types()) {
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
          continue typeLoop;
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
          continue typeLoop;
        }
      }

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
              continue typeLoop;
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
      const { toConstructorArguments, defaultKeys } = duckType;
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
            continue typeLoop;
          } else {
            scratchSpace[key] = converted;
          }
        }
      }

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

class DTree {
  constructor(duckTypes, keys, parent) {
    const count = duckTypes.length;

    this.parent = parent;
    this.count = count;
    this.key = null;
    this.duckTypes = null;
    this.haveNot = null;
    this.have = null;
    this.valueMap = null;

    if (count <= 1 || keys.size === 0) {
      this.duckTypes = duckTypes;
      return;
    }

    let bestInformationGain = -Infinity;
    let bestPartitionKey = null;
    let bestPartition = null;

    // For an N-way classifier, the entropy is
    //   H(X) = -(sum from i=1..n, p(xi) * log p(xi)
    // so since we are trying to classify each duckType separately,
    // the entropy before is
    //   count * -(1/count) * log(1/count)
    // but log(1/count) = -log(count) so

    const entropyBefore = Math.log2(count);

    // Find the highest information value partition.
    for (const key of keys) {
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
      let denom = 0;
      let entropyAfter = 0;
      function moreEntropy(n) {
        if (n) {
          entropyAfter += n * Math.log2(n);
          denom += n;
        }
      }
      moreEntropy(haveNot.length);
      moreEntropy(haveWithoutSpecialValue.length);
      if (valueMap) {
        for (const [ , types ] of valueMap) {
          moreEntropy(types.length + haveWithoutSpecialValue.length);
        }
      }
      entropyAfter /= denom;

      const informationGain = entropyBefore - entropyAfter;
      if (informationGain > bestInformationGain) {
        bestInformationGain = informationGain;
        bestPartitionKey = key;
        bestPartition = { haveNot, haveWithoutSpecialValue, valueMap };
      }
    }

    const { haveNot, haveWithoutSpecialValue, valueMap } = bestPartition;
    if (bestInformationGain === 0 &&
        haveNot.length === count && haveWithoutSpecialValue.length === count) {
      // Don't bother with nodes for optional properties without special values.
      this.duckTypes = duckTypes;
    } else {
      keys.delete(bestPartitionKey);
      this.key = bestPartitionKey;
      this.haveNot = new DTree(haveNot, keys, this);
      this.have = new DTree(haveWithoutSpecialValue, keys, this);
      if (valueMap) {
        this.valueMap = new Map();
        for (const [ k, ts ] of valueMap) {
          this.valueMap.set(
            k, new DTree(ts.concat(haveNot), keys, this));
        }
      }
      keys.add(bestPartitionKey);
    }
  }

  types() {
    return (this.duckTypes || [])[Symbol.iterator]();
  }

  /**
   *
   */
  duckHunt(x) {
    // Loop from unrolling tail calls.
    // eslint-disable-next-line consistent-this
    for (let node = this; true;) { // eslint-disable-line no-constant-condition
      // Return if we reached a leaf.
      if (node.duckTypes) {
        return node;
      }

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
    return obj;
  }
}

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

    for (const keys of [ getOwnPropertyNames(rawProperties), getOwnPropertySymbols(rawProperties) ]) {
      for (const key of keys) {
        if (key === '__proto__') {
          throw new Error(
            '__proto__ has a special meaning that is incompatible with POJOs');
        }
        const rawProperty = rawProperties[key];
        const property = {};
        setPrototypeOf(property, null);

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
              if (typeof type === 'string') {
                if (type !== typeof value) {
                  return notApplicable;
                }
              } else if (typeof type === 'function') {
                // TODO: substitute Array for isArray, etc.
                if (!(value && value instanceof type)) {
                  return notApplicable;
                }
              }
            }
            let tvalue = value;
            if (requireTrusted && !trusted) {
              tvalue = innocuous;
            }
            return (rawConvert) ?
              rawConvert(tvalue, trusted, userContext, notApplicable) : tvalue;
          };
          convertKeys.push(key);
        } else if (rawConvert) {
          property.convert = rawConvert;
          convertKeys.push(key);
        }
        properties[key] = property;
      }
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

function makePond(duckTypes) {
  let root = null;
  const metadataMaker = duckTypeMetadataMaker();

  function getRoot() {
    if (!root) {
      const keys = new Set();
      const addKey = keys.add.bind(keys);
      for (let i = 0, n = duckTypes.length; i < n; ++i) {
        const props = duckTypes[i].properties;
        getOwnPropertyNames(props).forEach(addKey);
        getOwnPropertySymbols(props).forEach(addKey);
      }
      root = new DTree(
        // Dedupe and normalize.
        Array.from(new Set(duckTypes)).map(metadataMaker),
        keys, null);
    }
    return root;
  }

  function unducker(trusted) {
    return function unduck(x, userContext) {
      return processor(trusted, getRoot(), userContext)(x);
    };
  }

  const pond = unducker(false);
  pond.trust = unducker(true);
  pond.withTypes = function withTypes(...moreDuckTypes) {
    const duckTypeSet = new Set(duckTypes);
    // Get all our ducks in a row.
    for (const duckType of moreDuckTypes) {
      duckTypeSet.add(duckType);
      // Run checks and fail early.
      metadataMaker(duckType);
    }

    return makePond(Array.from(duckTypeSet));
  };
  pond._diagnostic = function _diagnostic() {
    return getRoot().toJSON();
  };
  return pond;
}


// Canonical name
module.exports.unduck =
  // Start with an empty pond and let clients add to it with
  // .withTypes(...).
  makePond([]);
module.DuckError = DuckError;
