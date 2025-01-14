/*
 * SPDX-License-Identifier: Apache-2.0
 *
 * The OpenSearch Contributors require contributions made to
 * this file be licensed under the Apache-2.0 license or a
 * compatible open source license.
 *
 * Any modifications Copyright OpenSearch Contributors. See
 * GitHub history for details.
 */

/*
 * Licensed to Elasticsearch B.V. under one or more contributor
 * license agreements. See the NOTICE file distributed with
 * this work for additional information regarding copyright
 * ownership. Elasticsearch B.V. licenses this file to you under
 * the Apache License, Version 2.0 (the "License"); you may
 * not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *    http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing,
 * software distributed under the License is distributed on an
 * "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
 * KIND, either express or implied.  See the License for the
 * specific language governing permissions and limitations
 * under the License.
 */

import _ from 'lodash';
import * as opensearch from '../opensearch/opensearch';

// NOTE: If this value ever changes to be a few seconds or less, it might introduce flakiness
// due to timing issues in our app.js tests.
const POLL_INTERVAL = 60000;
let pollTimeoutId;

let perIndexTypes = {};
let perAliasIndices = {};
let templates = [];

export function expandAliases(indicesOrAliases) {
  // takes a list of indices or aliases or a string which may be either and returns a list of indices
  // returns a list for multiple values or a string for a single.

  if (!indicesOrAliases) {
    return indicesOrAliases;
  }

  if (typeof indicesOrAliases === 'string') {
    indicesOrAliases = [indicesOrAliases];
  }

  indicesOrAliases = indicesOrAliases.map((iOrA) => {
    if (perAliasIndices[iOrA]) {
      return perAliasIndices[iOrA];
    }
    return [iOrA];
  });
  let ret = [].concat.apply([], indicesOrAliases);
  ret.sort();
  ret = ret.reduce((result, value, index, array) => {
    const last = array[index - 1];
    if (last !== value) {
      result.push(value);
    }
    return result;
  }, []);

  return ret.length > 1 ? ret : ret[0];
}

export function getTemplates() {
  return [...templates];
}

export function getFields(indices, types) {
  // get fields for indices and types. Both can be a list, a string or null (meaning all).
  let ret = [];
  indices = expandAliases(indices);

  if (typeof indices === 'string') {
    const typeDict = perIndexTypes[indices];
    if (!typeDict) {
      return [];
    }

    if (typeof types === 'string') {
      const f = typeDict[types];
      ret = f ? f : [];
    } else {
      // filter what we need
      Object.entries(typeDict).forEach(([type, fields]) => {
        if (!types || types.length === 0 || types.includes(type)) {
          ret.push(fields);
        }
      });

      ret = [].concat.apply([], ret);
    }
  } else {
    // multi index mode.
    Object.keys(perIndexTypes).forEach((index) => {
      if (!indices || indices.length === 0 || indices.includes(index)) {
        ret.push(getFields(index, types));
      }
    });
    ret = [].concat.apply([], ret);
  }

  return _.uniqBy(ret, function (f) {
    return f.name + ':' + f.type;
  });
}

export function getTypes(indices) {
  let ret = [];
  indices = expandAliases(indices);
  if (typeof indices === 'string') {
    const typeDict = perIndexTypes[indices];
    if (!typeDict) {
      return [];
    }

    // filter what we need
    if (Array.isArray(typeDict)) {
      typeDict.forEach((type) => {
        ret.push(type);
      });
    } else if (typeof typeDict === 'object') {
      Object.keys(typeDict).forEach((type) => {
        ret.push(type);
      });
    }
  } else {
    // multi index mode.
    Object.keys(perIndexTypes).forEach((index) => {
      if (!indices || indices.includes(index)) {
        ret.push(getTypes(index));
      }
    });
    ret = [].concat.apply([], ret);
  }

  return _.uniq(ret);
}

export function getIndices(includeAliases) {
  const ret = [];
  Object.keys(perIndexTypes).forEach((index) => {
    ret.push(index);
  });

  if (typeof includeAliases === 'undefined' ? true : includeAliases) {
    Object.keys(perAliasIndices).forEach((alias) => {
      ret.push(alias);
    });
  }
  return ret;
}

function getFieldNamesFromFieldMapping(fieldName, fieldMapping) {
  if (fieldMapping.enabled === false) {
    return [];
  }
  let nestedFields;

  function applyPathSettings(nestedFieldNames) {
    const pathType = fieldMapping.path || 'full';
    if (pathType === 'full') {
      return nestedFieldNames.map((f) => {
        f.name = fieldName + '.' + f.name;
        return f;
      });
    }
    return nestedFieldNames;
  }

  if (fieldMapping.properties) {
    // derived object type
    nestedFields = getFieldNamesFromProperties(fieldMapping.properties);
    return applyPathSettings(nestedFields);
  }

  const fieldType = fieldMapping.type;

  const ret = { name: fieldName, type: fieldType };

  if (fieldMapping.index_name) {
    ret.name = fieldMapping.index_name;
  }

  if (fieldMapping.fields) {
    nestedFields = Object.entries(fieldMapping.fields).flatMap(([fieldName, fieldMapping]) => {
      return getFieldNamesFromFieldMapping(fieldName, fieldMapping);
    });
    nestedFields = applyPathSettings(nestedFields);
    nestedFields.unshift(ret);
    return nestedFields;
  }

  return [ret];
}

function getFieldNamesFromProperties(properties = {}) {
  const fieldList = Object.entries(properties).flatMap(([fieldName, fieldMapping]) => {
    return getFieldNamesFromFieldMapping(fieldName, fieldMapping);
  });

  // deduping
  return _.uniqBy(fieldList, function (f) {
    return f.name + ':' + f.type;
  });
}

function loadTemplates(templatesObject = {}) {
  templates = Object.keys(templatesObject);
}

export function loadMappings(mappings) {
  perIndexTypes = {};

  Object.entries(mappings).forEach(([index, indexMapping]) => {
    const normalizedIndexMappings = {};

    // Migrate 1.0.0 mappings. This format has changed, so we need to extract the underlying mapping.
    if (indexMapping.mappings && Object.keys(indexMapping).length === 1) {
      indexMapping = indexMapping.mappings;
    }

    Object.entries(indexMapping).forEach(([typeName, typeMapping]) => {
      if (typeName === 'properties') {
        const fieldList = getFieldNamesFromProperties(typeMapping);
        normalizedIndexMappings[typeName] = fieldList;
      } else {
        normalizedIndexMappings[typeName] = [];
      }
    });
    perIndexTypes[index] = normalizedIndexMappings;
  });
}

export function loadAliases(aliases) {
  perAliasIndices = {};
  Object.entries(aliases).forEach(([index, omdexAliases]) => {
    // verify we have an index defined. useful when mapping loading is disabled
    perIndexTypes[index] = perIndexTypes[index] || {};

    Object.keys(omdexAliases.aliases || {}).forEach((alias) => {
      if (alias === index) {
        return;
      } // alias which is identical to index means no index.
      let curAliases = perAliasIndices[alias];
      if (!curAliases) {
        curAliases = [];
        perAliasIndices[alias] = curAliases;
      }
      curAliases.push(index);
    });
  });

  perAliasIndices._all = getIndices(false);
}

export function clear() {
  perIndexTypes = {};
  perAliasIndices = {};
  templates = [];
}

function retrieveSettings(http, settingsKey, settingsToRetrieve, dataSourceId) {
  const settingKeyToPathMap = {
    fields: '_mapping',
    indices: '_aliases',
    templates: '_template',
  };

  // Fetch autocomplete info if setting is set to true, and if user has made changes.
  if (settingsToRetrieve[settingsKey] === true) {
    return opensearch.send(http, 'GET', settingKeyToPathMap[settingsKey], null, dataSourceId);
  } else {
    if (settingsToRetrieve[settingsKey] === false) {
      // If the user doesn't want autocomplete suggestions, then clear any that exist
      return Promise.resolve({});
    } else {
      // If the user doesn't want autocomplete suggestions, then clear any that exist
      return Promise.resolve();
    }
  }
}

// Retrieve all selected settings by default.
// TODO: We should refactor this to be easier to consume. Ideally this function should retrieve
// whatever settings are specified, otherwise just use the saved settings. This requires changing
// the behavior to not *clear* whatever settings have been unselected, but it's hard to tell if
// this is possible without altering the autocomplete behavior. These are the scenarios we need to
// support:
//   1. Manual refresh. Specify what we want. Fetch specified, leave unspecified alone.
//   2. Changed selection and saved: Specify what we want. Fetch changed and selected, leave
//      unchanged alone (both selected and unselected).
//   3. Poll: Use saved. Fetch selected. Ignore unselected.

export function clearSubscriptions() {
  if (pollTimeoutId) {
    clearTimeout(pollTimeoutId);
  }
}

const retrieveMappings = async (http, settingsToRetrieve, dataSourceId) => {
  const { body: mappings } = await retrieveSettings(
    http,
    'fields',
    settingsToRetrieve,
    dataSourceId
  );
  if (mappings) {
    const maxMappingSize = Object.keys(mappings).length > 10 * 1024 * 1024;
    let mappingsResponse;
    if (maxMappingSize) {
      console.warn(
        `Mapping size is larger than 10MB (${
          Object.keys(mappings).length / 1024 / 1024
        } MB). Ignoring...`
      );
      mappingsResponse = '{}';
    } else {
      mappingsResponse = mappings;
    }
    loadMappings(mappingsResponse);
  }
};

const retrieveAliases = async (http, settingsToRetrieve, dataSourceId) => {
  const { body: aliases } = await retrieveSettings(
    http,
    'indices',
    settingsToRetrieve,
    dataSourceId
  );

  if (aliases) {
    loadAliases(aliases);
  }
};

const retrieveTemplates = async (http, settingsToRetrieve, dataSourceId) => {
  const { body: templates } = await retrieveSettings(
    http,
    'templates',
    settingsToRetrieve,
    dataSourceId
  );

  if (templates) {
    loadTemplates(templates);
  }
};

/**
 *
 * @param settings Settings A way to retrieve the current settings
 * @param settingsToRetrieve any
 */
export function retrieveAutoCompleteInfo(http, settings, settingsToRetrieve, dataSourceId) {
  clearSubscriptions();

  Promise.allSettled([
    retrieveMappings(http, settingsToRetrieve, dataSourceId),
    retrieveAliases(http, settingsToRetrieve, dataSourceId),
    retrieveTemplates(http, settingsToRetrieve, dataSourceId),
  ]).then(() => {
    // Schedule next request.
    pollTimeoutId = setTimeout(() => {
      // This looks strange/inefficient, but it ensures correct behavior because we don't want to send
      // a scheduled request if the user turns off polling.
      if (settings.getPolling()) {
        retrieveAutoCompleteInfo(http, settings, settings.getAutocomplete(), dataSourceId);
      }
    }, POLL_INTERVAL);
  });
}
