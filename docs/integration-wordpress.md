# Intégration WordPress — moteur de réservation en iframe

Le tunnel de réservation (`/book/`) est la **seule** page du site intégrable
dans une iframe : `x-frame-options: DENY` est levé uniquement pour elle
(`src/services/http-headers.ts` côté Worker, `staticHeaders` de
`node/server.mjs` côté Node). Toutes les autres pages refusent l'intégration.

## 1. Shortcode à coller dans `functions.php` du thème (ou dans un plugin)

```php
/**
 * Intègre le moteur de réservation en iframe responsive.
 * Usage : [gites_reservation] ou [gites_reservation property="pre-more" lang="nl"]
 */
function gites_reservation_shortcode( $atts ) {
    $atts = shortcode_atts( array(
        'property' => 'pre-more',
        'lang'     => 'fr',
        'height'   => '1400',
    ), $atts, 'gites_reservation' );

    $base = 'https://dev1.mdcdy.be/book/'; // à remplacer par le domaine définitif
    $src  = add_query_arg( array(
        'property' => $atts['property'],
        'lang'     => $atts['lang'],
    ), $base );

    return sprintf(
        '<div style="position:relative;width:100%%;padding-bottom:0;">
            <iframe src="%s" style="width:100%%;height:%spx;border:0;max-width:1100px;margin:0 auto;display:block;" loading="lazy" title="Réservation"></iframe>
        </div>',
        esc_url( $src ),
        esc_attr( $atts['height'] )
    );
}
add_shortcode( 'gites_reservation', 'gites_reservation_shortcode' );
```

## 2. Utilisation dans une page ou un article

```
[gites_reservation]
[gites_reservation property="pre-more" lang="fr" height="1600"]
```

## 3. Sans PHP : l'iframe brute

Dans un bloc **HTML personnalisé** Gutenberg :

```html
<iframe src="https://dev1.mdcdy.be/book/?property=pre-more&lang=fr"
        style="width:100%;height:1400px;border:0;max-width:1100px;margin:0 auto;display:block;"
        loading="lazy" title="Réservation"></iframe>
```

## Notes

- L'URL de base (`$base`) est à remplacer le jour où le domaine définitif
  remplace `dev1.mdcdy.be` (cf. `docs/mise-en-ligne.md` § 3).
- Les paramètres du deep-link (`checkin`, `checkout`, `adults`, `children`,
  `unit`) passent tels quels : on peut les ajouter à l'attribut `src`.
- Le tunnel fait ses appels vers `/api/public/*` en relatif : l'iframe n'a
  besoin d'aucune configuration CORS.
- La hauteur est fixe (1400–1600 px recommandés) : le tunnel est conçu pour
  une page autonome et n'émet pas de message `postMessage` de redimensionnement.
