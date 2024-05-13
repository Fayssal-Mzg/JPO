const functions = require('firebase-functions');
const admin = require('firebase-admin');
const puppeteer = require('puppeteer-core');
const chromium = require('chrome-aws-lambda');

admin.initializeApp();
const db = admin.firestore();

exports.screenshot = functions.runWith({
    memory: '2GB'
}).https.onRequest(async (request, res) => {
    let result = null;
    let browser = null;

    try {
        // Configuration pour  utiliser le navigateur précompilé 
        browser = await puppeteer.launch({
            args: [...chromium.args, '--disable-features=IsolateOrigins,site-per-process'],
            executablePath: await chromium.executablePath,
            headless: chromium.headless,
        });

        let page = await browser.newPage();
        await page.goto('https://dossier.parcoursup.fr/Candidat/carte');

        const allElements = [];
        await retrieveButtonContent(page, allElements, 1, db);

        await browser.close();

        res.status(200).send('Scraping and saving to Firestore completed.');
    } catch (error) {
        console.error('An error occurred:', error);
        res.status(500).send('An error occurred while scraping and saving to Firestore.');
    }
});

async function retrieveButtonContent(currentPage, allElements, maxPages, db) {
    let pageCount = 0;
    while (pageCount < maxPages) {
        const buttons = await currentPage.$$eval('.fr-card', divs => divs.map(div => {
            const button = div.querySelector('a.fr-btn');
            return button ? button.href : null;
        }).filter(href => href !== null));

        for (const button of buttons) {
            const elements = await scrapePage(currentPage, button);
            await saveToFirestore(elements, db);
        }

        const hasMorePages = await goToNextPage(currentPage);
        if (!hasMorePages) break;
        pageCount++;
    }
}

async function scrapePage(currentPage, buttonLink) {
    const newPage = await currentPage.browser().newPage();
    await newPage.goto(buttonLink);
    await newPage.waitForSelector('.fr-grid-row', { timeout: 10000 }); // Augmentez le timeout si nécessaire
    const formation = await newPage.$eval('h1.fr-h2.fr-mb-1w', el => el.textContent.trim());

    const elements = await newPage.$$eval('.fr-tile__body .fr-accordion', (sections, formation) => {
        if (sections.length === 0) {
            return [{
                formation,
                date: '',
                horaire: '',
                présence: '',
                commentaire: '',
                lien: ''
            }];
        }

        return sections.map(section => {
            const date = section.querySelector('.fr-accordion__btn .fr-badge')?.textContent.trim() || '';
            const horaire = section.querySelector('.fr-collapse.fr-collapse--expanded p > strong')?.textContent.trim() || '';
            const présence = section.querySelector('.list-unstyled .fr-icon-arrow-right-line')?.textContent.trim() || '';
            const commentaireElement = section.querySelectorAll('.fr-collapse--expanded strong').find(el => el.textContent.trim() === "Commentaire de l'établissement :");
            const commentaire = commentaireElement ? commentaireElement.nextElementSibling.textContent.trim() : '';
            const lienElement = section.querySelector('.fr-icon-arrow-right-line a');
            const lien = lienElement ? lienElement.getAttribute('href') : '';

            return {
                formation,
                date,
                horaire,
                présence,
                commentaire,
                lien
            };
        });
    }, formation);


    await newPage.close();
    return elements;
}


async function goToNextPage(currentPage) {
    const nextPageButton = await currentPage.$('button.fr-pagination__link.fr-pagination__link--next');
    if (nextPageButton) {
        await nextPageButton.click();
        await currentPage.waitForSelector('.fr-card', { visible: true });
        return true;
    }
    return false;
}

async function saveToFirestore(elements, db) {
    console.log("Attempting to save the following elements:", elements);
    if (elements.length === 0) {
        console.log("No elements to save.");
        return;
    }
    try {
        const batch = db.batch();
        elements.forEach((element, index) => {
            const docRef = db.collection("parcoursup_data").doc(`data_${index}`);
            batch.set(docRef, element);
        });
        await batch.commit();
        console.log("Data saved to Firestore.");
    } catch (error) {
        console.error('An error occurred while saving to Firestore:', error);
        throw error;
    }
}
