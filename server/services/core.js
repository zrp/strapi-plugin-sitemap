'use strict';

/**
 * Sitemap service.
 */

const { getAbsoluteServerUrl } = require('@strapi/utils');
const { SitemapStream, streamToPromise, SitemapAndIndexStream } = require('sitemap');
const { isEmpty } = require('lodash');

const { logMessage, getService, formatCache, mergeCache } = require('../utils');

/**
 * Get a formatted array of different language URLs of a single page.
 *
 * @param {object} config - The config object.
 * @param {object} page - The entity.
 * @param {string} contentType - The model of the entity.
 * @param {string} defaultURL - The default URL of the different languages.
 *
 * @returns {array} The language links.
 */
const getLanguageLinks = async (config, page, contentType, defaultURL) => {
  if (!page.localizations) return null;

  const links = [];
  links.push({ lang: page.locale, url: defaultURL });

  await Promise.all(page.localizations.map(async (translation) => {
    let { locale } = translation;

    // Return when there is no pattern for the page.
    if (
      !config.contentTypes[contentType]['languages'][locale]
      && config.contentTypes[contentType]['languages']['und']
    ) {
      locale = 'und';
    } else if (
      !config.contentTypes[contentType]['languages'][locale]
      && !config.contentTypes[contentType]['languages']['und']
    ) {
      return null;
    }

    const { pattern } = config.contentTypes[contentType]['languages'][locale];
    const translationUrl = await strapi.plugins.sitemap.services.pattern.resolvePattern(pattern, translation);
    let hostnameOverride = config.hostname_overrides[translation.locale] || '';
    hostnameOverride = hostnameOverride.replace(/\/+$/, '');
    links.push({
      lang: translation.locale,
      url: `${hostnameOverride}${translationUrl}`,
    });
  }));

  return links;
};

/**
 * Get a formatted sitemap entry object for a single page.
 *
 * @param {object} config - The config object.
 * @param {object} page - The entity.
 * @param {string} contentType - The model of the entity.
 *
 * @returns {object} The sitemap entry data.
 */
const getSitemapPageData = async (config, page, contentType) => {
  let locale = page.locale || 'und';

  // Return when there is no pattern for the page.
  if (
    !config.contentTypes[contentType]['languages'][locale]
    && config.contentTypes[contentType]['languages']['und']
  ) {
    locale = 'und';
  } else if (
    !config.contentTypes[contentType]['languages'][locale]
    && !config.contentTypes[contentType]['languages']['und']
  ) {
    return null;
  }

  const { pattern } = config.contentTypes[contentType]['languages'][locale];
  const path = await strapi.plugins.sitemap.services.pattern.resolvePattern(pattern, page);
  let hostnameOverride = config.hostname_overrides[page.locale] || '';
  hostnameOverride = hostnameOverride.replace(/\/+$/, '');
  const url = `${hostnameOverride}${path}`;

  const pageData = {
    lastmod: page.updatedAt,
    url: url,
    links: await getLanguageLinks(config, page, contentType, url),
    changefreq: config.contentTypes[contentType]['languages'][locale].changefreq || 'monthly',
    priority: parseFloat(config.contentTypes[contentType]['languages'][locale].priority) || 0.5,
  };

  if (config.contentTypes[contentType]['languages'][locale].includeLastmod === false) {
    delete pageData.lastmod;
  }

  if (config.contentTypes[contentType]['languages'][locale].subTypeNews === true) {
    Object.assign(pageData, {
      news: {
        publication: {
          name: config.contentTypes[contentType]['languages'][locale].subTypeNewsName,
          language: locale,
        },
        title: page[config.contentTypes[contentType]['languages'][locale].subTypeNewsTitle],
        publication_date: page.publishedAt,
      },
    });
  }

  return pageData;
};

/**
 * Get array of sitemap entries based on the plugins configurations.
 *
 * @param {object} invalidationObject - An object containing the types and ids to invalidate
 *
 * @returns {object} The cache and regular entries.
 */
const createSitemapEntries = async (invalidationObject) => {
  const config = await getService('settings').getConfig();
  const sitemapEntries = [];
  const cacheEntries = {};

  // Collection entries.
  await Promise.all(Object.keys(config.contentTypes).map(async (contentType) => {
    if (invalidationObject && !Object.keys(invalidationObject).includes(contentType)) {
      return;
    }

    cacheEntries[contentType] = {};

    // Query all the pages
    const pages = await getService('query').getPages(config, contentType, invalidationObject?.[contentType]?.ids);

    // Add formatted sitemap page data to the array.
    await Promise.all(pages.map(async (page, i) => {
      const pageData = await getSitemapPageData(config, page, contentType);
      if (pageData) {
        sitemapEntries.push(pageData);

        // Add page to the cache.
        cacheEntries[contentType][page.id] = pageData;
      }
    }));

  }));


  // Custom entries.
  await Promise.all(Object.keys(config.customEntries).map(async (customEntry) => {
    sitemapEntries.push({
      url: customEntry,
      changefreq: config.customEntries[customEntry].changefreq,
      priority: parseFloat(config.customEntries[customEntry].priority),
    });
  }));

  // Custom homepage entry.
  if (config.includeHomepage) {
    const hasHomePage = !isEmpty(sitemapEntries.filter((entry) => entry.url === ''));

    // Only add it when no other '/' entry is present.
    if (!hasHomePage) {
      sitemapEntries.push({
        url: '/',
        changefreq: 'monthly',
        priority: 1,
      });
    }
  }

  return { cacheEntries, sitemapEntries };
};

/**
 * Write the sitemap xml file in the public folder.
 *
 * @param {string} filename - The file name.
 * @param {SitemapStream} sitemap - The SitemapStream instance.
 * @param {bool} isIndex - Is a sitemap index
 *
 * @returns {void}
 */
const saveSitemap = async (filename, sitemap, isIndex) => {
  return streamToPromise(sitemap)
    .then(async (sm) => {
      try {
        return await getService('query').createSitemap({
          sitemap_string: sm.toString(),
          name: 'default',
          delta: 0,
          type: isIndex ? 'index' : 'default_hreflang',
        });
      } catch (e) {
        strapi.log.error(logMessage(`Something went wrong while trying to write the sitemap XML to the database. ${e}`));
        throw new Error();
      }
    })
    .catch((err) => {
      strapi.log.error(logMessage(`Something went wrong while trying to build the sitemap with streamToPromise. ${err}`));
      throw new Error();
    });
};

/**
 * Get the SitemapStream instance.
 *
 * @param {number} urlCount - The amount of URLs.
 *
 * @returns {SitemapStream} - The sitemap stream.
 */
const getSitemapStream = async (urlCount) => {
  const config = await getService('settings').getConfig();
  const LIMIT = strapi.config.get('plugin.sitemap.limit');
  const enableXsl = strapi.config.get('plugin.sitemap.xsl');
  const { serverUrl } = getAbsoluteServerUrl(strapi.config);

  const xslObj = {
    xmlns: { // trim the xml namespace
      news: true, // flip to false to omit the xml namespace for news
      xhtml: true,
      image: true,
      video: true,
      custom: [
        'xsi:schemaLocation="http://www.sitemaps.org/schemas/sitemap/0.9 http://www.sitemaps.org/schemas/sitemap/0.9/sitemap.xsd"',
        'xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"',
      ],
    },
  };

  if (enableXsl) {
    xslObj.xslUrl = 'xsl/sitemap.xsl';
  }

  if (urlCount <= LIMIT) {
    return [new SitemapStream({
      hostname: config.hostname,
      ...xslObj,
    }), false];
  } else {

    return [new SitemapAndIndexStream({
      limit: LIMIT,
      ...xslObj,
      lastmodDateOnly: false,
      getSitemapStream: (i) => {
        const sitemapStream = new SitemapStream({
          hostname: config.hostname,
          ...xslObj,
        });
        const delta = i + 1;
        const path = `api/sitemap/index.xml?page=${delta}`;

        streamToPromise(sitemapStream)
          .then((sm) => {
            getService('query').createSitemap({
              sitemap_string: sm.toString(),
              name: 'default',
              type: 'default_hreflang',
              delta,
            });
          });

        return [new URL(path, serverUrl || config.hostname || 'http://localhost:1337').toString(), sitemapStream];
      },
    }), true];
  }
};

/**
 * The main sitemap generation service.
 *
 * @param {array} cache - The cached JSON
 * @param {object} invalidationObject - An object containing the types and ids to invalidate
 *
 * @returns {void}
 */
const createSitemap = async (cache, invalidationObject) => {
  const cachingEnabled = strapi.config.get('plugin.sitemap.caching');
  const autoGenerationEnabled = strapi.config.get('plugin.sitemap.autoGenerate');

  try {
    const {
      sitemapEntries,
      cacheEntries,
    } = await createSitemapEntries(invalidationObject);
    // Format cache to regular entries
    const formattedCache = formatCache(cache, invalidationObject);

    const allEntries = [
      ...sitemapEntries,
      ...formattedCache,
    ];

    if (isEmpty(allEntries)) {
      strapi.log.info(logMessage('No sitemap XML was generated because there were 0 URLs configured.'));
      return;
    }

    await getService('query').deleteSitemap('default');

    const [sitemap, isIndex] = await getSitemapStream(allEntries.length);

    allEntries.map((sitemapEntry) => sitemap.write(sitemapEntry));
    sitemap.end();

    const sitemapId = await saveSitemap('default', sitemap, isIndex);

    if (cachingEnabled && autoGenerationEnabled) {
      if (!cache) {
        getService('query').createSitemapCache(cacheEntries, 'default', sitemapId);
      } else {
        const newCache = mergeCache(cache, cacheEntries);
        getService('query').updateSitemapCache(newCache, 'default', sitemapId);
      }
    }

    strapi.log.info(logMessage('The sitemap XML has been generated. It can be accessed on /api/sitemap/index.xml.'));
  } catch (err) {
    strapi.log.error(logMessage(`Something went wrong while trying to build the SitemapStream. ${err}`));
    throw new Error();
  }
};

module.exports = () => ({
  getLanguageLinks,
  getSitemapPageData,
  createSitemapEntries,
  saveSitemap,
  createSitemap,
});
