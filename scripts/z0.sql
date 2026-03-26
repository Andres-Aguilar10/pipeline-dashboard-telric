WITH
recurrent_styles AS (
    SELECT DISTINCT estilo_cliente AS pol_customer_style_id
    FROM silver.costo_wip_op
    WHERE version_calculo = 'FLUIDA'
      AND prendas_requeridas >= 200
      AND estilo_cliente IS NOT NULL
      AND TRIM(estilo_cliente) != ''
),
pr_src AS (
    SELECT
        s.pr_factory_id,
        NULLIF(TRIM(s.pr_id), '') AS pr_id,
        s.pr_cancelled_t, s.pr_annulment_t, s.pol_annulment_t, s.pol_closed_t,
        COALESCE(s.po_customer_name_grp, 'OTHERS') AS po_customer_name_grp,
        COALESCE(s.pol_requested_q, 0) AS pol_requested_q,
        s.pol_delivery_rescheduled_t, s.po_published_t,
        s.po_last_pol_delivery_rescheduled_t, s.po_created_t,
        s.po_class, s.po_subclass, s.po_shipment_type,
        TRIM(s.po_customer_id) AS po_customer_id,
        s.po_season_year, s.po_season_id,
        s.pol_customer_style_created_t, s.pol_garment_class_group_id,
        s.pol_garment_class_group_description, s.pol_garment_class_description,
        s.pol_destination, s.pol_amount_usd, s.pol_customer_style_id,
        s.pols_factory_style_id, s.po_customer_name, s.pol_unit_price
    FROM silver.pr AS s
    WHERE COALESCE(s.po_last_pol_delivery_rescheduled_t, s.po_published_t, s.po_created_t) >= '2020-01-01'
      AND s.po_class = 'PO' AND s.po_subclass = 'PR'
),
pr AS (
    SELECT
        pr_factory_id, pr_id,
        MAX(pr_cancelled_t) AS pr_cancelled_t,
        MAX(pr_annulment_t) AS pr_annulment_t,
        MAX(pol_annulment_t) AS pol_annulment_t,
        CASE
            WHEN SUM(pol_requested_q) <= 500 THEN 500
            WHEN SUM(pol_requested_q) <= 1000 THEN 1000
            WHEN SUM(pol_requested_q) <= 4000 THEN 4000
            WHEN SUM(pol_requested_q) <= 10000 THEN 10000
            ELSE 10001
        END AS pol_requested_group,
        MAX(po_customer_name_grp) AS po_customer_name_grp,
        SUM(pol_requested_q) AS pol_requested_q,
        MAX(pol_delivery_rescheduled_t) AS pol_delivery_rescheduled_t,
        MAX(po_published_t) AS po_published_t,
        MAX(po_shipment_type) AS po_shipment_type,
        MAX(po_customer_id) AS po_customer_id,
        MAX(po_season_year) AS po_season_year,
        MAX(po_season_id) AS po_season_id,
        MAX(pol_customer_style_created_t) AS pol_customer_style_created_t,
        MAX(pol_garment_class_group_id) AS pol_garment_class_group_id,
        MAX(pol_garment_class_group_description) AS pol_garment_class_group_description,
        MAX(pol_garment_class_description) AS pol_garment_class_description,
        MAX(pol_destination) AS pol_destination,
        SUM(COALESCE(pol_amount_usd, 0)) AS pol_amount_usd,
        MAX(pol_customer_style_id) AS pol_customer_style_id,
        MAX(pols_factory_style_id) AS pols_factory_style_id,
        MAX(po_customer_name) AS po_customer_name,
        MAX(pol_unit_price) AS pol_unit_price
    FROM pr_src
    WHERE pr_id IS NOT NULL
      AND pr_cancelled_t IS NULL AND pr_annulment_t IS NULL
      AND pol_annulment_t IS NULL AND pol_closed_t IS NULL
      AND pol_requested_q > 0
    GROUP BY pr_factory_id, pr_id
),
plan_orders AS (
    SELECT p.pr_factory_id, p.pr_id
    FROM silver.wip_plan AS p
    GROUP BY p.pr_factory_id, p.pr_id
),
real_agg AS (
    SELECT
        w.pr_factory_id, w.pr_id,
        MAX(CASE WHEN w.wip_id = '49' THEN w.end_ts END) AS end_49,
        MAX(CASE WHEN w.start_ts IS NOT NULL THEN 1 ELSE 0 END) AS has_real_start_any
    FROM silver.wip_real AS w
    GROUP BY w.pr_factory_id, w.pr_id
),
incomplete_full AS (
    SELECT
        b.pr_factory_id, b.pr_id,
        COALESCE(r.has_real_start_any, 0) AS has_real_start_any
    FROM plan_orders AS b
    FULL OUTER JOIN real_agg AS r
        ON r.pr_factory_id = b.pr_factory_id AND r.pr_id = b.pr_id
    WHERE r.end_49 IS NULL
),
z0_pr AS (
    SELECT
        o.pr_id AS order_id,
        CASE WHEN o.has_real_start_any = 0 THEN 'NI' ELSE 'IN' END AS status,
        pr.po_customer_name, pr.pol_garment_class_description,
        pr.pol_customer_style_id, pr.pols_factory_style_id,
        CASE WHEN rs.pol_customer_style_id IS NOT NULL THEN 'recurrente' ELSE 'nuevo' END AS style_type,
        pr.pol_unit_price, pr.pol_requested_q,
        CONCAT(pr.pol_requested_group, pr.po_customer_name_grp) AS order_group,
        pr.pol_delivery_rescheduled_t AS due_date,
        pr.po_published_t, pr.po_shipment_type, pr.po_customer_id,
        pr.po_season_year, pr.po_season_id,
        pr.pol_customer_style_created_t, pr.pol_garment_class_group_id,
        pr.pol_garment_class_group_description, pr.pol_destination,
        pr.pol_amount_usd, pr.po_customer_name_grp
    FROM incomplete_full AS o
    INNER JOIN pr ON pr.pr_factory_id = o.pr_factory_id AND pr.pr_id = o.pr_id
    LEFT JOIN recurrent_styles AS rs ON rs.pol_customer_style_id = pr.pol_customer_style_id
),
po_src AS (
    SELECT
        TRIM(s.po_customer_id) AS po_customer_id,
        NULLIF(TRIM(s.po_id), '') AS po_id,
        NULLIF(TRIM(s.pol_id), '') AS pol_id,
        NULLIF(TRIM(s.pr_id), '') AS pr_id,
        COALESCE(s.po_customer_name_grp, 'OTHERS') AS po_customer_name_grp,
        s.po_published_t, s.po_created_t,
        s.po_delivery_original_t, s.po_delivery_updated_t,
        s.po_last_pol_delivery_rescheduled_t,
        s.pol_delivery_original_t, s.pol_delivery_updated_t,
        s.pol_delivery_rescheduled_t, s.pol_annulment_t, s.pol_closed_t,
        COALESCE(s.pol_requested_q, 0) AS pol_requested_q,
        s.po_shipment_type, s.po_season_year, s.po_season_id,
        s.pol_customer_style_created_t, s.pol_garment_class_group_id,
        s.pol_garment_class_group_description, s.pol_garment_class_description,
        s.pol_destination, s.pol_amount_usd, s.pol_customer_style_id,
        s.pols_factory_style_id, s.po_customer_name, s.pol_unit_price
    FROM silver.pr AS s
    WHERE COALESCE(s.po_last_pol_delivery_rescheduled_t, s.po_published_t, s.po_created_t) >= '2020-01-01'
      AND s.po_class = 'PO' AND s.po_subclass = 'PR'
      AND s.pol_requested_q <> 0
),
po_agg AS (
    SELECT
        po_customer_id, po_id, pol_id,
        MAX(po_customer_name_grp) AS po_customer_name_grp,
        MAX(po_published_t) AS po_published_t,
        MAX(po_created_t) AS po_created_t,
        MAX(COALESCE(pol_delivery_rescheduled_t, pol_delivery_updated_t,
            pol_delivery_original_t, po_delivery_updated_t, po_delivery_original_t)) AS due_date,
        SUM(CASE WHEN pol_id IS NULL THEN 0 ELSE pol_requested_q END) AS pol_requested_q,
        MAX(CASE WHEN pr_id IS NOT NULL THEN 1 ELSE 0 END) AS has_pr_any,
        MAX(po_shipment_type) AS po_shipment_type,
        MAX(po_season_year) AS po_season_year,
        MAX(po_season_id) AS po_season_id,
        MAX(pol_customer_style_created_t) AS pol_customer_style_created_t,
        MAX(pol_garment_class_group_id) AS pol_garment_class_group_id,
        MAX(pol_garment_class_group_description) AS pol_garment_class_group_description,
        MAX(pol_garment_class_description) AS pol_garment_class_description,
        MAX(pol_destination) AS pol_destination,
        SUM(CASE WHEN pol_id IS NULL THEN 0 ELSE COALESCE(pol_amount_usd, 0) END) AS pol_amount_usd,
        MAX(pol_customer_style_id) AS pol_customer_style_id,
        MAX(pols_factory_style_id) AS pols_factory_style_id,
        MAX(po_customer_name) AS po_customer_name,
        MAX(pol_unit_price) AS pol_unit_price
    FROM po_src
    WHERE (pol_id IS NULL) OR (pol_annulment_t IS NULL AND pol_closed_t IS NULL)
    GROUP BY po_customer_id, po_id, pol_id
),
po_no_pr_at_po AS (
    SELECT po_customer_id, po_id,
        MAX(CASE WHEN pr_id IS NOT NULL THEN 1 ELSE 0 END) AS has_pr_any_at_po
    FROM po_src
    GROUP BY po_customer_id, po_id
),
z0_po AS (
    SELECT
        CASE WHEN a.pol_id IS NULL
            THEN CONCAT('PO', a.po_id, '_', a.po_customer_id)
            ELSE CONCAT('PO', a.po_id, '_', a.pol_id, '_', a.po_customer_id)
        END AS order_id,
        'PO' AS status,
        a.po_customer_name, a.pol_garment_class_description,
        a.pol_customer_style_id, a.pols_factory_style_id,
        CASE WHEN rs.pol_customer_style_id IS NOT NULL THEN 'recurrente' ELSE 'nuevo' END AS style_type,
        a.pol_unit_price, a.pol_requested_q,
        CONCAT(
            CASE
                WHEN a.pol_requested_q <= 500 THEN 500
                WHEN a.pol_requested_q <= 1000 THEN 1000
                WHEN a.pol_requested_q <= 4000 THEN 4000
                WHEN a.pol_requested_q <= 10000 THEN 10000
                ELSE 10001
            END, a.po_customer_name_grp
        ) AS order_group,
        a.due_date, a.po_published_t, a.po_shipment_type, a.po_customer_id,
        a.po_season_year, a.po_season_id,
        a.pol_customer_style_created_t, a.pol_garment_class_group_id,
        a.pol_garment_class_group_description, a.pol_destination,
        a.pol_amount_usd, a.po_customer_name_grp
    FROM po_agg AS a
    INNER JOIN po_no_pr_at_po AS p
        ON p.po_customer_id = a.po_customer_id AND p.po_id = a.po_id
    LEFT JOIN recurrent_styles AS rs
        ON rs.pol_customer_style_id = a.pol_customer_style_id
    WHERE (a.pol_id IS NOT NULL AND a.has_pr_any = 0 AND a.due_date >= '2025-01-01')
       OR (a.pol_id IS NULL AND p.has_pr_any_at_po = 0 AND a.po_published_t >= '2025-01-01')
),
z0 AS (
    SELECT * FROM z0_pr
    UNION ALL
    SELECT * FROM z0_po
)
SELECT order_id, status, po_customer_name, pol_garment_class_description,
    pol_customer_style_id, pols_factory_style_id, style_type,
    pol_unit_price, pol_requested_q, order_group, due_date,
    po_published_t, po_shipment_type, po_customer_id,
    po_season_year, po_season_id, pol_customer_style_created_t,
    pol_garment_class_group_id, pol_garment_class_group_description,
    pol_destination, pol_amount_usd, po_customer_name_grp
FROM z0;