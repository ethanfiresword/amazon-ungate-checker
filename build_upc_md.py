import csv
import html

with open('lotus_light_catalog_upcs.csv', 'r', encoding='utf-8') as f:
    reader = list(csv.DictReader(f))

unique_products = {}
for r in reader:
    upc = r['upc'].strip()
    if upc and upc not in unique_products:
        title = html.unescape(r['title'].strip())
        unique_products[upc] = {
            'upc': upc,
            'sku': r['sku'].strip(),
            'title': title
        }

lines = []
lines.append('# Lotus Light Wholesale Catalog - Scraped UPC Master List\n')
lines.append(f'**Total Unique Products / UPCs Extracted**: {len(unique_products)}\n')
lines.append('| # | UPC / Barcode | SKU | Product Name / Description |')
lines.append('|---|---|---|---|')

for idx, (upc, item) in enumerate(unique_products.items(), 1):
    title = item['title'].replace('|', '-')
    sku = item['sku']
    lines.append(f"| {idx} | `{upc}` | `{sku}` | {title} |")

with open('output_upc_list.md', 'w', encoding='utf-8') as f:
    f.write('\n'.join(lines))

print(f'Successfully generated output_upc_list.md with {len(unique_products)} UPCs!')
