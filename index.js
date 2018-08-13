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
  getOwnPropertyNames,
  getOwnPropertySymbols,
  hasOwnProperty,
  setPrototypeOf,
} = Object;


/** A breadcrumb used to identify object graph cycles. */
const IN_PROGRESS_BREADCRUMB = {};

class DuckError extends TypeError {
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
  return process; // eslint-disable-line no-use-before-define

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

    const xIsArray = isArray(x);
    let result = null;
    if (xIsArray) {
      // For arrays, we recursively process everything.
      // We create a this-realm array.
      result = [];

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
    } else {
      // Use a temporary object so we don't multiply read fields.
      const scratchSpace = {};
      setPrototypeOf(scratchSpace, null);
      for (let stringKeys = getOwnPropertyNames(x),
        i = 0, n = stringKeys.length;
        i < n; ++i) {
        const key = stringKeys[i];
        if (key !== '__proto__') {
          // HACK: could fall back to Object.defineProperty
          // when key === '__proto__'
          scratchSpace[key] = x[key];
        }
      }
      for (let symbolKeys = getOwnPropertySymbols(x),
        i = 0, n = symbolKeys.length;
        i < n; ++i) {
        const key = symbolKeys[i];
        scratchSpace[key] = x[key];
      }

      const node = root.duckHunt(scratchSpace, process);
      if (node.count === 1) {
        // Fast tack
        const duckType = node.types().next().value;
        const { recurseToKeys } = duckType;
        for (let i = 0, n = recurseToKeys.length; i < n; ++i) {
          const recKey = recurseToKeys[i];
          if (recKey in scratchSpace) {
            scratchSpace[recKey] = process(scratchSpace[recKey]);
          }
        }
        const { convertKeys } = duckType;
        const notApplicable = {};
        for (let i = 0, n = convertKeys.length; i < n; ++i) {
          const key = convertKeys[i];
          if (key in scratchSpace) {
            const converted = duckType.properties[key].convert(
              scratchSpace[key], trusted, userContext, notApplicable);
            if (converted === notApplicable) {
              throw new MissingDuckError(
                `Failed to convert property ${ key } using type ${
                  duckType.classType.name }`);
            }
            scratchSpace[key] = converted;
          }
        }
        const { toConstructorArguments } = duckType;
        const args = toConstructorArguments(scratchSpace, userContext, trusted);
        if (!isArray(args)) {
          throw new MissingDuckError(
            `Duck hunt could not compute arguments to ${ duckType.classType.name }`);
        }
        const ClassType = duckType.classType;
        result = new ClassType(...args);
      } else {
        const { applicableConstructorArgs, applicableDuckType } =
          // Try without collecting error trace.
          tentativelyApplyDuckTypes(node, scratchSpace, false);
        if (!applicableConstructorArgs) {
          // TODO: map node.types() to type names.
          // TODO: use suppressed errors.
          throw new MissingDuckError({
            errorMessage: null,
            toString() {
              if (this.errorMessage === null) {
                // Redo with the extra work to collect error trace.
                const { errorMessage } = tentativelyApplyDuckTypes(
                  node, scratchSpace, true);
                this.errorMessage = errorMessage ||
                  `Failed to compute constructor arguments for [${
                    Array.from(node.types()).map((duckType) => duckType.classType.name)
                  }]`;
              }
              return this.errorMessage;
            },
          });
        }
        for (let i = 0, n = applicableDuckType.recurseToKeys.length; i < n; ++i) {
          const recKey = applicableDuckType.recurseToKeys[i];
          if (recKey in scratchSpace) {
            scratchSpace[recKey] = process(scratchSpace[recKey]);
          }
        }
        const ClassType = applicableDuckType.classType;
        result = new ClassType(...applicableConstructorArgs);
      }
    }
    unduckingMap.set(x, result);
    return result;
  }

  function tentativelyApplyDuckTypes(node, scratchSpace, collectErrorTrace) {
    let applicableDuckType = null;
    let applicableConstructorArgs = null;
    // If we eventually find an applicable type, consider these water
    // under the duck.
    const suppressedErrors = collectErrorTrace ? [] : null;
    const notApplicable = {};

    const originals = new Map();
    for (const duckType of node.types()) {
      // Compute recursive field values before trying to convert to
      // constructor arguments.
      let ok = true;
      const { recurseToKeys } = duckType;
      for (let i = 0, n = recurseToKeys.length; i < n; ++i) {
        const recKey = recurseToKeys[i];
        if (recKey in scratchSpace) {
          originals.set(recKey, scratchSpace[recKey]);
          try {
            // unduckingMap doubles as a memo-table so we will not multiply
            // evaluate.
            scratchSpace[recKey] = process(scratchSpace[recKey]);
          } catch (exc) {
            if (exc instanceof MissingDuckError) {
              // The eventual match may not care about this.
              ok = false;
              if (suppressedErrors) {
                suppressedErrors.push(duckType, exc);
              }
              break;
            }
            throw exc;
          }
        }
      }
      if (ok) {
        const { convertKeys } = duckType;
        for (let i = 0, n = convertKeys.length; i < n; ++i) {
          const key = convertKeys[i];
          if (key in scratchSpace) {
            const converted = duckType.properties[key].convert(
              scratchSpace[key], trusted, userContext, notApplicable);
            if (converted !== notApplicable) {
              if (!originals.has(converted)) {
                originals.set(key, scratchSpace[key]);
              }
              scratchSpace[key] = converted;
            } else {
              ok = false;
              if (suppressedErrors) {
                suppressedErrors.push(
                  duckType,
                  new MissingDuckError(
                    `Failed to convert property ${ key } using type ${
                      duckType.classType.name }`));
              }
              break;
            }
          }
        }
      }
      if (ok) {
        // Recursively unducked and converted all.
        const toConstructorArguments = { duckType };
        const args = toConstructorArguments(scratchSpace, userContext, trusted);
        if (isArray(args)) {
          if (applicableDuckType) {
            throw new DuckError(
              `Duck hunt found multiple applicable types: ${
                applicableDuckType.classType.name
              } and ${ duckType.classType.name }`);
          }
          applicableDuckType = duckType;
          applicableConstructorArgs = args;
        }
      }
      for (const [ key, value ] of originals) {
        scratchSpace[key] = value;
      }
      originals.clear();
    }
    let errorMessage = null;
    if (!applicableDuckType && suppressedErrors) {
      errorMessage = [];
      for (let i = 0, n = suppressedErrors.length; i < n; i += 2) {
        errorMessage.push(`${ suppressedErrors[i].classType.name }: ${ suppressedErrors[i + 1] }`);
      }
      errorMessage = errorMessage.join('\n');
    }
    return { applicableConstructorArgs, applicableDuckType, errorMessage };
  }
}

class DTree {
  constructor(duckTypes, keys, parent, metadataMaker) {
    const count = duckTypes.length;

    this.parent = parent;
    this.count = count;
    this.key = null;
    this.duckTypes = null;
    this.haveNot = null;
    this.have = null;
    this.specialValueMap = null;

    if (count <= 1) {
      this.duckTypes = duckTypes.map(metadataMaker);
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
        if (key in duckType.properties) {
          const propertyDescriptor = duckType.properties;
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
        } else {
          haveNot.push(duckType);
        }
      }
      let denom = 0;
      let entropyAfter = 0;
      function moreEntropy(n) {
        entropyAfter += n * Math.log2(n);
        denom += n;
      }
      moreEntropy(haveNot.length);
      moreEntropy(haveWithoutSpecialValue.length);
      if (valueMap) {
        for (const [ , types ] of valueMap) {
          moreEntropy(types.length + haveWithoutSpecialValue.length);
        }
      }
      entropyAfter /= denom;

      const informationGain = entropyAfter - entropyBefore;
      if (informationGain > bestInformationGain) {
        bestInformationGain = informationGain;
        bestPartitionKey = key;
        bestPartition = { haveNot, haveWithoutSpecialValue, valueMap };
      }
    }

    const { haveNot, haveWithoutSpecialValue, valueMap } = bestPartition;
    keys.delete(bestPartitionKey);
    this.key = bestPartitionKey;
    this.haveNot = new DTree(haveNot, keys, this, metadataMaker);
    this.have = new DTree(haveWithoutSpecialValue, keys, this, metadataMaker);
    if (valueMap) {
      this.valueMap = new Map();
      for (const [ k, ts ] of valueMap) {
        this.valueMap.set(
          k, new DTree(ts.concat(haveWithoutSpecialValue), keys, this, metadataMaker));
      }
    }
    keys.add(bestPartitionKey);
  }

  types() {
    return (this.duckTypes || [])[Symbol.iterator]();
  }

  /**
   *
   */
  duckHunt(x, process) {
    // Loop from unrolling tail calls.
    // eslint-disable-next-line consistent-this
    for (let node = this; true;) { // eslint-disable-line no-constant-condition
      // Return if we reached a leaf.
      if (node.duckTypes) {
        return node;
      }

      const { key } = node;
      if (key in x) {
        let { valueMap } = node;
        // Unless the specific value indicates otherwise.
        node = node.have;
        if (valueMap) {
          let value = null;
          try {
            value = process(x[key]);
          } catch (exc) {
            if (!(exc instanceof DuckError)) {
              throw exc;
            }
            valueMap = null;
          }
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
      checked.push(node.key);
    }
    checked.reverse();
    const available = [ ...getOwnPropertyNames(x), ...getOwnPropertySymbols(x) ];
    return `Could not find duck type for\n[${
      checked }]\ngiven value with properties\n[${
      available }]`;
  }
}

function duckTypeMetadataMaker() {
  const metadataMap = new Map();
  return function makeMetadata(duckType) {
    if (!(hasOwnProperty.call(duckType, 'classType') &&
          typeof duckType.classType === 'function')) {
      throw new Error('Duck type missing .classType');
    }
    if (!(hasOwnProperty.call(duckType, 'properties') &&
          typeof duckType.properties === 'object' &&
          duckType.properties)) {
      throw new Error('Duck type missing .properties');
    }
    if (!(hasOwnProperty.call(duckType, 'toConstructorArguments') &&
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

        if (!hasOwnProperty.call(rawProperty, 'recurse') ||
            rawProperty.recurse === true) {
          recurseToKeys.push(key);
        }

        if (hasOwnProperty.call(rawProperty, 'value')) {
          property.value = rawProperty.value;
        } else {
          let rawConvert = hasOwnProperty.call(rawProperty, 'convert') ?
            rawProperty.convert : null;
          if (typeof rawConvert !== 'function') {
            rawConvert = null;
          }

          const requireTrusted = hasOwnProperty.call(rawProperty, 'trusted') &&
              rawProperty.trusted === true;

          let type = hasOwnProperty.call(rawProperty, 'type') ?
            rawProperty.type : null;
          if (typeof type !== 'string' && typeof type !== 'function') {
            type = null;
          }

          const innocuous = hasOwnProperty.call(rawProperty, 'innocuous') ?
            rawProperty.innocuous : null;

          if (rawConvert || requireTrusted || type) {
            property.convert = function convert(value, trusted, userContext, notApplicable) {
              if (type) {
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
              if (requireTrusted && !trusted) {
                return innocuous;
              }
              return (rawConvert) ?
                rawConvert(value, trusted, userContext, notApplicable) : value;
            };
            convertKeys.push(key);
          }
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
    };

    metadataMap.set(duckType, augmented);
    return augmented;
  };
}

function makePond(duckTypes) {
  let root = null;
  const metadataMaker = duckTypeMetadataMaker();

  function unducker(trusted) {
    return function unduck(x, userContext) {
      if (!root && duckTypes.length) {
        const keys = new Set();
        const addKey = keys.add.bind(keys);
        for (let i = 0, n = duckTypes.length; i < n; ++i) {
          const props = duckTypes[i].properties;
          getOwnPropertyNames(props).forEach(addKey);
          getOwnPropertySymbols(props).forEach(addKey);
        }
        root = new DTree(
          Array.from(new Set(duckTypes)), keys, null, metadataMaker);
      }
      return processor(trusted, root, userContext)(x);
    };
  }

  const pond = unducker(false);
  pond.trusted = unducker(true);
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
  return pond;
}


// Canonical name
module.exports.unduck =
  // Abbreviate
  // eslint-disable-next-line no-multi-assign
  module.exports.ud =
    // Start with an empty pond and let clients add to it with
    // .withTypes(...).
    makePond([]);
module.DuckError = DuckError;
