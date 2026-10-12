-- Migration 0036 : conditions générales de location, version 3.1.
--
-- Décision de Julien du 12/10/2026, appliquée telle quelle :
--   1. annulation. Le client annule : les arrhes restent acquises à
--      l'exploitant, le reste est remboursé sous 14 jours. L'exploitant annule
--      (hors force majeure) : tout ce qui a été payé est remboursé sous 14 jours
--      et il verse en outre une indemnité égale aux arrhes (décision du 12/10
--      après lecture de l'art. VI.83, 27° du CDE, réciprocité). Force majeure :
--      tout est remboursé, sans indemnité. Aucune autre indemnité. Plus de
--      renvoi à l'article 1590 de l'ancien Code civil.
--   2. articles 4 et 5 réécrits (arrhes, solde à 30 jours, annulation par le
--      client, par l'exploitant, force majeure, non-présentation, séjour
--      entamé), résumé « Comment ça se passe » en tête du texte.
--   3. vocabulaire : « client » et « exploitant » remplacent « locataire » et
--      « propriétaire » dans tout le texte. Le document joint à la
--      confirmation s'appelle « Confirmation de réservation et conditions
--      générales », ce n'est plus un contrat.
--
-- Mêmes règles que la 0019 : texte brut, aucun point-virgule ni double tiret
-- dans le littéral, apostrophes doublées. Les chiffres sont ceux en base :
-- arrhes au pourcentage de l'hébergement (units.deposit_pct, 50, migration
-- 0015), solde à 30 jours (balance_due_days), 18 h et 18 h (migration 0009),
-- aucune caution (caution_cents à 0).
--
-- Archivage : le texte en place, s'il n'est pas déjà la version 3.1, est
-- copié sous la clé cgv_text_avant_3_1 (INSERT OR IGNORE : la première copie
-- est la bonne, un rejeu n'écrase rien). getSettings ne lit pas cette clé.
-- Puis INSERT OR REPLACE pose la 3.1 : la migration est rejouable.

INSERT OR IGNORE INTO settings (property_id, key, value)
  SELECT property_id, 'cgv_text_avant_3_1', value FROM settings
  WHERE key = 'cgv_text' AND property_id IN (1, 2) AND value NOT LIKE '%Version 3.1 —%';

INSERT OR REPLACE INTO settings (property_id, key, value) VALUES
  (1, 'cgv_text', 'CONDITIONS GÉNÉRALES DE LOCATION

Version 3.1 — 12 octobre 2026. Le texte intégral est affiché avant toute réservation. L''acceptation est conservée avec sa version, sa date, son heure et l''adresse IP du réservant.

Comment ça se passe

1. Vous choisissez vos dates et votre hébergement, puis vous réservez en ligne.
2. Vous lisez et acceptez les présentes conditions générales.
3. Vous payez les arrhes en ligne. Si l''arrivée a lieu dans moins de 30 jours, vous payez la totalité du prix.
4. Vous recevez par e-mail la confirmation de votre réservation, avec le récapitulatif du séjour et les présentes conditions.
5. Vous payez le solde au plus tard 30 jours avant l''arrivée, depuis la page de votre réservation.
6. Arrivée à partir de 18 h. Départ avant 18 h, ou à l''heure indiquée lors de la réservation.
7. Pour toute question, écrivez-nous par e-mail en rappelant votre référence de réservation.

Ce résumé ne remplace pas les articles qui suivent.

Article 1 — Parties et objet

Les présentes conditions régissent la location saisonnière des hébergements meublés de tourisme suivants : La Maison du Scieur et La Scierie (Hameau du Pré Moré, 6890 Redu, commune de Libin), ainsi que Le Moulin de Braives (Braives), ci-après « l''hébergement ».

L''exploitant est Jean-Philippe de Cartier d''Yves, personne physique domiciliée Rue des Barbouillons 12, 6929 Daverdisse (ci-après « l''exploitant »).

Le « client » est la personne majeure qui effectue la réservation. Il se porte fort du respect des présentes par tous les occupants.

Article 2 — Réservation

2.1. La réservation s''effectue en ligne. Elle est ferme lorsque le client a (a) accepté les présentes conditions et (b) payé les arrhes visées à l''article 4. Le client reçoit alors par e-mail une confirmation de réservation, avec le récapitulatif du séjour et les présentes conditions.

2.2. Une réservation dont les arrhes ne sont pas payées dans le délai indiqué lors de la réservation est libérée automatiquement, sans formalité.

Article 3 — Prix

3.1. Le prix affiché au moment de la réservation est ferme. Il comprend la mise à disposition de l''hébergement, les charges usuelles (eau, électricité, chauffage), les frais généraux de séjour (ménage et charges) et les options choisies. Le détail est ventilé ligne par ligne dans le devis avant paiement.

3.2. Les prix s''entendent en euros. Aucun coût supplémentaire obligatoire n''est ajouté après la réservation.

Article 4 — Arrhes et paiement du solde

4.1. À la réservation, le client verse des arrhes. Leur montant est égal au pourcentage du prix total fixé pour l''hébergement réservé et affiché lors de la réservation (50 % du prix total, sauf mention contraire sur la fiche de l''hébergement).

4.2. Le solde est payable au plus tard 30 jours avant l''arrivée. S''il n''est pas payé à l''échéance et qu''un rappel reste sans effet pendant 7 jours, l''exploitant peut annuler la réservation. Cette annulation suit le régime de l''annulation par le client (article 5.2).

4.3. Si la réservation intervient moins de 30 jours avant l''arrivée, la totalité du prix est payable à la réservation. La part qui correspond aux arrhes, au pourcentage propre à l''hébergement, suit le régime des arrhes.

Article 5 — Caution et annulation

5.1. Aucune caution n''est demandée.

5.2. Annulation par le client. Si le client annule sa réservation, hors cas de force majeure, les arrhes restent acquises à l''exploitant. Ce que le client a payé au-delà des arrhes lui est remboursé dans les 14 jours, sur le moyen de paiement utilisé.

5.3. Annulation par l''exploitant. Si l''exploitant annule la réservation, hors cas de force majeure, il rembourse au client tout ce que celui-ci a payé, arrhes comprises, dans les 14 jours, sur le moyen de paiement utilisé, et lui verse en outre une indemnité égale au montant des arrhes.

5.4. Force majeure. Si un événement de force majeure, au sens du droit belge, rend le séjour impossible, la réservation est annulée. Tout ce que le client a payé, arrhes comprises, lui est remboursé dans les 14 jours, sur le moyen de paiement utilisé, sans indemnité de part ni d''autre.

5.5. Non-présentation et séjour entamé. Le client qui ne se présente pas sans avoir annulé, ou qui écourte un séjour commencé, ne récupère pas le prix du séjour. Ce qu''il a payé au-delà de ce prix lui est remboursé dans les 14 jours.

5.6. En dehors de l''indemnité prévue à l''article 5.3, aucune autre indemnité n''est due, ni par le client ni par l''exploitant.

5.7. Le client est invité à souscrire une assurance annulation auprès de l''assureur de son choix. L''exploitant n''en propose pas.

Article 6 — Absence de droit de rétractation

Conformément à l''article VI.53, 12°, du Code de droit économique, le droit de rétractation ne s''applique pas aux prestations de logement fournies à une date déterminée. La réservation est donc ferme dès sa confirmation, sous le seul régime de l''article 5.

Article 7 — Capacité et usage

7.1. Le nombre d''occupants, bébés compris pour la sécurité incendie, ne peut excéder la capacité maximale indiquée pour l''hébergement réservé. L''exploitant peut refuser l''accès aux occupants surnuméraires. En cas de dépassement dissimulé, il peut mettre fin à la réservation sans remboursement.

7.2. L''hébergement est destiné au séjour touristique exclusivement : pas de fête ou d''événement non convenu par écrit, pas de sous-location, pas d''établissement de domicile. Il est interdit de fumer à l''intérieur.

Article 8 — Arrivée, départ, état de l''hébergement

8.1. Arrivée à partir de 18 h, départ avant 18 h, sauf accord écrit contraire. Les horaires sont lus des réglages de l''hébergement et affichés lors de la réservation.

8.2. L''hébergement est remis propre et en bon état. Le client signale toute anomalie dans les 24 h de l''arrivée. À défaut, l''hébergement est présumé conforme. Il restitue les lieux rangés, la vaisselle propre et les déchets triés selon les consignes locales. Les frais généraux ne couvrent pas la remise en ordre anormale.

Article 9 — Dommages et responsabilité

9.1. Le client répond des dégradations et pertes causées pendant le séjour par lui-même ou ses occupants. Les dommages constatés sont documentés (photos, relevé contradictoire dans la mesure du possible) et facturés au coût réel de réparation ou de remplacement.

9.2. Le client vérifie que sa responsabilité civile (assurance familiale, extension « villégiature ») couvre la location de vacances.

9.3. La responsabilité de l''exploitant est limitée aux dommages causés par un défaut de l''hébergement qui lui est imputable. Elle ne couvre pas les effets personnels des occupants ni les nuisances extérieures indépendantes de sa volonté.

Article 10 — Animaux

Les animaux sont admis sur demande préalable adressée à l''exploitant avant la réservation et acceptée par écrit. Un supplément éventuel est affiché dans les options. Un animal non annoncé peut être refusé à l''arrivée. Le client répond des dommages et du nettoyage supplémentaire qu''il occasionne.

Article 11 — Données personnelles

Les données du client (identité, coordonnées, contenu des échanges, données de réservation et de paiement) sont traitées par l''exploitant aux seules fins de gestion de la réservation, du séjour et des obligations légales, en ce compris la tenue du registre des personnes hébergées imposée par la loi. Elles ne sont ni vendues ni transmises à des tiers hors prestataires techniques nécessaires (hébergement, paiement). Le client ne reçoit de messages commerciaux que s''il y a consenti. Droits d''accès, de rectification et d''effacement : par écrit à l''adresse de contact indiquée sur le site.

Article 12 — Force majeure

La force majeure libère chaque partie. Ses effets sur les sommes payées sont ceux de l''article 5.4, quelle que soit la partie qui l''invoque.

Article 13 — Droit applicable et litiges

Les présentes sont régies par le droit belge. Avant toute action, les parties recherchent une solution amiable. Les litiges relèvent des tribunaux compétents en vertu du droit commun. À l''égard d''un client consommateur, les règles impératives de compétence et de protection lui restent acquises.'),
  (2, 'cgv_text', 'CONDITIONS GÉNÉRALES DE LOCATION

Version 3.1 — 12 octobre 2026. Le texte intégral est affiché avant toute réservation. L''acceptation est conservée avec sa version, sa date, son heure et l''adresse IP du réservant.

Comment ça se passe

1. Vous choisissez vos dates et votre hébergement, puis vous réservez en ligne.
2. Vous lisez et acceptez les présentes conditions générales.
3. Vous payez les arrhes en ligne. Si l''arrivée a lieu dans moins de 30 jours, vous payez la totalité du prix.
4. Vous recevez par e-mail la confirmation de votre réservation, avec le récapitulatif du séjour et les présentes conditions.
5. Vous payez le solde au plus tard 30 jours avant l''arrivée, depuis la page de votre réservation.
6. Arrivée à partir de 18 h. Départ avant 18 h, ou à l''heure indiquée lors de la réservation.
7. Pour toute question, écrivez-nous par e-mail en rappelant votre référence de réservation.

Ce résumé ne remplace pas les articles qui suivent.

Article 1 — Parties et objet

Les présentes conditions régissent la location saisonnière des hébergements meublés de tourisme suivants : La Maison du Scieur et La Scierie (Hameau du Pré Moré, 6890 Redu, commune de Libin), ainsi que Le Moulin de Braives (Braives), ci-après « l''hébergement ».

L''exploitant est Jean-Philippe de Cartier d''Yves, personne physique domiciliée Rue des Barbouillons 12, 6929 Daverdisse (ci-après « l''exploitant »).

Le « client » est la personne majeure qui effectue la réservation. Il se porte fort du respect des présentes par tous les occupants.

Article 2 — Réservation

2.1. La réservation s''effectue en ligne. Elle est ferme lorsque le client a (a) accepté les présentes conditions et (b) payé les arrhes visées à l''article 4. Le client reçoit alors par e-mail une confirmation de réservation, avec le récapitulatif du séjour et les présentes conditions.

2.2. Une réservation dont les arrhes ne sont pas payées dans le délai indiqué lors de la réservation est libérée automatiquement, sans formalité.

Article 3 — Prix

3.1. Le prix affiché au moment de la réservation est ferme. Il comprend la mise à disposition de l''hébergement, les charges usuelles (eau, électricité, chauffage), les frais généraux de séjour (ménage et charges) et les options choisies. Le détail est ventilé ligne par ligne dans le devis avant paiement.

3.2. Les prix s''entendent en euros. Aucun coût supplémentaire obligatoire n''est ajouté après la réservation.

Article 4 — Arrhes et paiement du solde

4.1. À la réservation, le client verse des arrhes. Leur montant est égal au pourcentage du prix total fixé pour l''hébergement réservé et affiché lors de la réservation (50 % du prix total, sauf mention contraire sur la fiche de l''hébergement).

4.2. Le solde est payable au plus tard 30 jours avant l''arrivée. S''il n''est pas payé à l''échéance et qu''un rappel reste sans effet pendant 7 jours, l''exploitant peut annuler la réservation. Cette annulation suit le régime de l''annulation par le client (article 5.2).

4.3. Si la réservation intervient moins de 30 jours avant l''arrivée, la totalité du prix est payable à la réservation. La part qui correspond aux arrhes, au pourcentage propre à l''hébergement, suit le régime des arrhes.

Article 5 — Caution et annulation

5.1. Aucune caution n''est demandée.

5.2. Annulation par le client. Si le client annule sa réservation, hors cas de force majeure, les arrhes restent acquises à l''exploitant. Ce que le client a payé au-delà des arrhes lui est remboursé dans les 14 jours, sur le moyen de paiement utilisé.

5.3. Annulation par l''exploitant. Si l''exploitant annule la réservation, hors cas de force majeure, il rembourse au client tout ce que celui-ci a payé, arrhes comprises, dans les 14 jours, sur le moyen de paiement utilisé, et lui verse en outre une indemnité égale au montant des arrhes.

5.4. Force majeure. Si un événement de force majeure, au sens du droit belge, rend le séjour impossible, la réservation est annulée. Tout ce que le client a payé, arrhes comprises, lui est remboursé dans les 14 jours, sur le moyen de paiement utilisé, sans indemnité de part ni d''autre.

5.5. Non-présentation et séjour entamé. Le client qui ne se présente pas sans avoir annulé, ou qui écourte un séjour commencé, ne récupère pas le prix du séjour. Ce qu''il a payé au-delà de ce prix lui est remboursé dans les 14 jours.

5.6. En dehors de l''indemnité prévue à l''article 5.3, aucune autre indemnité n''est due, ni par le client ni par l''exploitant.

5.7. Le client est invité à souscrire une assurance annulation auprès de l''assureur de son choix. L''exploitant n''en propose pas.

Article 6 — Absence de droit de rétractation

Conformément à l''article VI.53, 12°, du Code de droit économique, le droit de rétractation ne s''applique pas aux prestations de logement fournies à une date déterminée. La réservation est donc ferme dès sa confirmation, sous le seul régime de l''article 5.

Article 7 — Capacité et usage

7.1. Le nombre d''occupants, bébés compris pour la sécurité incendie, ne peut excéder la capacité maximale indiquée pour l''hébergement réservé. L''exploitant peut refuser l''accès aux occupants surnuméraires. En cas de dépassement dissimulé, il peut mettre fin à la réservation sans remboursement.

7.2. L''hébergement est destiné au séjour touristique exclusivement : pas de fête ou d''événement non convenu par écrit, pas de sous-location, pas d''établissement de domicile. Il est interdit de fumer à l''intérieur.

Article 8 — Arrivée, départ, état de l''hébergement

8.1. Arrivée à partir de 18 h, départ avant 18 h, sauf accord écrit contraire. Les horaires sont lus des réglages de l''hébergement et affichés lors de la réservation.

8.2. L''hébergement est remis propre et en bon état. Le client signale toute anomalie dans les 24 h de l''arrivée. À défaut, l''hébergement est présumé conforme. Il restitue les lieux rangés, la vaisselle propre et les déchets triés selon les consignes locales. Les frais généraux ne couvrent pas la remise en ordre anormale.

Article 9 — Dommages et responsabilité

9.1. Le client répond des dégradations et pertes causées pendant le séjour par lui-même ou ses occupants. Les dommages constatés sont documentés (photos, relevé contradictoire dans la mesure du possible) et facturés au coût réel de réparation ou de remplacement.

9.2. Le client vérifie que sa responsabilité civile (assurance familiale, extension « villégiature ») couvre la location de vacances.

9.3. La responsabilité de l''exploitant est limitée aux dommages causés par un défaut de l''hébergement qui lui est imputable. Elle ne couvre pas les effets personnels des occupants ni les nuisances extérieures indépendantes de sa volonté.

Article 10 — Animaux

Les animaux sont admis sur demande préalable adressée à l''exploitant avant la réservation et acceptée par écrit. Un supplément éventuel est affiché dans les options. Un animal non annoncé peut être refusé à l''arrivée. Le client répond des dommages et du nettoyage supplémentaire qu''il occasionne.

Article 11 — Données personnelles

Les données du client (identité, coordonnées, contenu des échanges, données de réservation et de paiement) sont traitées par l''exploitant aux seules fins de gestion de la réservation, du séjour et des obligations légales, en ce compris la tenue du registre des personnes hébergées imposée par la loi. Elles ne sont ni vendues ni transmises à des tiers hors prestataires techniques nécessaires (hébergement, paiement). Le client ne reçoit de messages commerciaux que s''il y a consenti. Droits d''accès, de rectification et d''effacement : par écrit à l''adresse de contact indiquée sur le site.

Article 12 — Force majeure

La force majeure libère chaque partie. Ses effets sur les sommes payées sont ceux de l''article 5.4, quelle que soit la partie qui l''invoque.

Article 13 — Droit applicable et litiges

Les présentes sont régies par le droit belge. Avant toute action, les parties recherchent une solution amiable. Les litiges relèvent des tribunaux compétents en vertu du droit commun. À l''égard d''un client consommateur, les règles impératives de compétence et de protection lui restent acquises.');
