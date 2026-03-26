export const Z0_QUERY = `
WITH
recurrent_styles AS (
    SELECT pol_customer_style_id
    FROM silver.pr
    WHERE po_last_pol_delivery_rescheduled_t >= '2022-01-01'
      AND po_class    = 'PO'
      AND po_subclass = 'PR'
    GROUP BY pol_customer_style_id
    HAVING COUNT(DISTINCT EXTRACT(YEAR FROM po_last_pol_delivery_rescheduled_t)) >= 3
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
`;

export const Z1_QUERY = `
WITH cfg AS (
    SELECT
        CAST('2025-01-27' AS timestamp) AS t_min,
        CAST('2026-01-27' AS timestamp) AS t_max
),
recurrent_styles AS (
    SELECT pol_customer_style_id
    FROM silver.pr
    WHERE po_last_pol_delivery_rescheduled_t >= '2022-01-01'
      AND UPPER(po_class) = 'PO' AND UPPER(po_subclass) = 'PR'
    GROUP BY pol_customer_style_id
    HAVING COUNT(DISTINCT EXTRACT(YEAR FROM po_last_pol_delivery_rescheduled_t)) >= 3
),
src AS (
    SELECT
        s.pr_factory_id, NULLIF(s.pr_id, '') AS pr_id,
        NULLIF(s.po_id, '') AS po_id, NULLIF(s.pol_id, '') AS pol_id,
        s.po_customer_id, s.po_class, s.po_subclass,
        s.pr_cancelled_t, s.pr_annulment_t, s.pol_annulment_t, s.pol_closed_t,
        s.pr_created_t, s.pol_created_t,
        s.pr_requested_q, s.pol_requested_q,
        COALESCE(s.po_customer_name_grp, 'OTHERS') AS po_customer_name_grp_n,
        s.pols_factory_style_id, s.pols_factory_style_version,
        s.po_customer_name, s.pol_garment_class_description,
        s.pol_customer_style_id, s.pol_unit_price
    FROM silver.pr AS s
    WHERE UPPER(s.po_class) = 'PO' AND UPPER(s.po_subclass) = 'PR'
),
src_pr_rn AS (
    SELECT pr_factory_id, pr_id, po_id, pr_requested_q,
        po_customer_name_grp_n, po_customer_name,
        pol_garment_class_description, pol_customer_style_id,
        pols_factory_style_id, pol_unit_price
    FROM (
        SELECT s.*, ROW_NUMBER() OVER (
            PARTITION BY s.pr_factory_id, s.pr_id
            ORDER BY s.pr_created_t DESC, s.pol_created_t DESC
        ) AS rn
        FROM src AS s
        WHERE s.pr_id IS NOT NULL AND s.pr_cancelled_t IS NULL
          AND s.pr_annulment_t IS NULL AND s.pol_annulment_t IS NULL
          AND s.pol_closed_t IS NULL
    ) AS t WHERE t.rn = 1
),
pr AS (
    SELECT u.*,
        CASE
            WHEN u.pr_requested_q <= 500 THEN 500
            WHEN u.pr_requested_q <= 1000 THEN 1000
            WHEN u.pr_requested_q <= 4000 THEN 4000
            WHEN u.pr_requested_q <= 10000 THEN 10000
            ELSE 10001
        END AS pr_requested_group,
        CONCAT(
            CASE
                WHEN u.pr_requested_q <= 500 THEN 500
                WHEN u.pr_requested_q <= 1000 THEN 1000
                WHEN u.pr_requested_q <= 4000 THEN 4000
                WHEN u.pr_requested_q <= 10000 THEN 10000
                ELSE 10001
            END, u.po_customer_name_grp_n
        ) AS order_group
    FROM src_pr_rn AS u
),
pol_src AS (
    SELECT s.*,
        CASE
            WHEN s.pol_requested_q <= 500 THEN 500
            WHEN s.pol_requested_q <= 1000 THEN 1000
            WHEN s.pol_requested_q <= 4000 THEN 4000
            WHEN s.pol_requested_q <= 10000 THEN 10000
            ELSE 10001
        END AS pol_requested_group
    FROM src AS s
    WHERE s.pol_annulment_t IS NULL AND s.pol_closed_t IS NULL
),
pol_agg AS (
    SELECT
        s.po_customer_id, s.po_id, s.pol_id,
        MAX(s.pol_requested_group) AS pol_requested_group,
        MAX(s.po_customer_name_grp_n) AS po_customer_name_grp_n,
        MAX(CASE WHEN s.pr_id IS NOT NULL THEN 1 ELSE 0 END) AS has_pr_any,
        MAX(s.pols_factory_style_id) AS cod_estpro,
        MAX(UPPER(s.pols_factory_style_version)) AS cod_version,
        MAX(s.po_customer_name) AS po_customer_name,
        MAX(s.pol_garment_class_description) AS pol_garment_class_description,
        MAX(s.pol_customer_style_id) AS pol_customer_style_id,
        MAX(s.pols_factory_style_id) AS pols_factory_style_id,
        MAX(s.pol_unit_price) AS pol_unit_price,
        SUM(s.pol_requested_q) AS pol_requested_q
    FROM pol_src AS s
    GROUP BY s.po_customer_id, s.po_id, s.pol_id
),
pol_only AS (
    SELECT a.po_customer_id, a.po_id, a.pol_id,
        CONCAT(a.pol_requested_group, a.po_customer_name_grp_n) AS order_group,
        a.po_customer_name, a.pol_garment_class_description,
        a.pol_customer_style_id, a.pols_factory_style_id,
        a.pol_unit_price, a.pol_requested_q
    FROM pol_agg AS a WHERE a.has_pr_any = 0
),
wip_49_end AS (
    SELECT r.pr_factory_id, r.pr_id, MAX(r.end_ts) AS end_49
    FROM silver.wip_real AS r WHERE r.wip_id = '49'
    GROUP BY r.pr_factory_id, r.pr_id
),
wip_real AS (
    SELECT x.pr_factory_id, x.pr_id, x.wip_id,
        x.start_ts AS real_start_ts, x.end_ts AS real_end_ts
    FROM silver.wip_real AS x CROSS JOIN cfg
    WHERE x.start_ts >= cfg.t_min
),
incomplete_orders AS (
    SELECT DISTINCT p.pr_factory_id, p.pr_id
    FROM pr AS p
    LEFT JOIN wip_49_end AS r
        ON r.pr_factory_id = p.pr_factory_id AND r.pr_id = p.pr_id
    WHERE r.end_49 IS NULL
),
wip_plan AS (
    SELECT p.*
    FROM silver.wip_plan AS p
    INNER JOIN incomplete_orders AS s
        ON s.pr_factory_id = p.pr_factory_id AND s.pr_id = p.pr_id
    WHERE p.start_ts >= '2024-05-24' AND p.plan_category = 23
      AND p.wip_id NOT IN ('81','82','79','10c')
),
incomplete_full AS (
    SELECT
        p.plan_category,
        p.start_ts AS plan_start_ts, p.end_ts AS plan_end_ts,
        r.real_start_ts, r.real_end_ts,
        COALESCE(p.pr_factory_id, r.pr_factory_id) AS pr_factory_id,
        COALESCE(p.pr_id, r.pr_id) AS pr_id,
        COALESCE(p.wip_id, r.wip_id) AS wip_id
    FROM wip_plan AS p
    FULL OUTER JOIN (
        SELECT wr.pr_factory_id, wr.pr_id, wr.wip_id, wr.real_start_ts, wr.real_end_ts
        FROM wip_real AS wr
        INNER JOIN incomplete_orders AS s
            ON s.pr_factory_id = wr.pr_factory_id AND s.pr_id = wr.pr_id
    ) AS r ON r.pr_factory_id = p.pr_factory_id AND r.pr_id = p.pr_id AND r.wip_id = p.wip_id
),
status AS (
    SELECT
        d.wip_id AS process_id, pr.po_id,
        d.pr_factory_id, d.pr_id,
        CASE WHEN d.real_start_ts IS NOT NULL THEN 1 ELSE 0 END AS start_is_real,
        CASE WHEN d.real_end_ts IS NOT NULL THEN 1 ELSE 0 END AS end_is_real,
        CASE
            WHEN MAX(CASE WHEN d.real_start_ts IS NOT NULL THEN 1 ELSE 0 END)
                 OVER (PARTITION BY d.pr_factory_id, d.pr_id) = 0
            THEN 'NI' ELSE 'IN'
        END AS pr_status,
        '20104498044' AS owner_id,
        pr.order_group,
        COALESCE(d.real_start_ts, d.plan_start_ts) AS start_ts,
        COALESCE(d.real_end_ts, d.plan_end_ts) AS end_ts,
        pr.po_customer_name, pr.pol_garment_class_description,
        pr.pol_customer_style_id, pr.pols_factory_style_id,
        pr.pol_unit_price, pr.pr_requested_q AS pol_requested_q
    FROM incomplete_full AS d
    INNER JOIN incomplete_orders AS o
        ON o.pr_factory_id = d.pr_factory_id AND o.pr_id = d.pr_id
    INNER JOIN pr ON pr.pr_factory_id = d.pr_factory_id AND pr.pr_id = d.pr_id
),
cod_proceso__wip_map AS (
    SELECT v.cod_proceso, v.wip_id FROM (VALUES
        ('0001','34'),('0002','24'),('0003','37'),('0004','40'),
        ('0005','45'),('0007','49'),('0008','45'),('0009','43'),
        ('0010','34'),('0011','45'),('0013','34'),('0014','45'),
        ('0016','49'),('0017','24'),('0018','37'),('0019','34'),
        ('0021','45'),('0023','19a'),('0024','34'),('0025','45'),
        ('0026','40'),('0027','40'),('0028','24'),('0029','24'),
        ('0032','34'),('0035','34'),('0036','36'),('0038','43'),
        ('0039','37'),('0040','34'),('0040','40'),('0040','49'),
        ('0041','24'),('0041','36'),('0041','44'),('0042','45'),
        ('0043','45'),('0044','45'),('0045','44'),('0046','34'),
        ('0047','34'),('0048','34'),('0049','34'),('0050','34'),
        ('0051','45')
    ) AS v(cod_proceso, wip_id)
),
rutas_proceso AS (
    SELECT DISTINCT b.cod_estpro, b.cod_version, b.cod_proceso
    FROM bronze.es_estprover_rutas_proceso AS b
),
pol_only_proc AS (
    SELECT DISTINCT
        p.po_customer_id, p.po_id, p.pol_id, p.order_group,
        m.wip_id AS process_id,
        p.po_customer_name, p.pol_garment_class_description,
        p.pol_customer_style_id, p.pols_factory_style_id,
        p.pol_unit_price, p.pol_requested_q
    FROM pol_only AS p
    INNER JOIN pol_agg AS a
        ON a.po_customer_id = p.po_customer_id AND a.po_id = p.po_id AND a.pol_id = p.pol_id
    INNER JOIN rutas_proceso AS r
        ON r.cod_estpro = a.cod_estpro AND r.cod_version = a.cod_version
    INNER JOIN cod_proceso__wip_map AS m ON m.cod_proceso = r.cod_proceso
    WHERE p.pol_id IS NOT NULL
),
z1 AS (
    SELECT
        z.process_id, z.owner_id, z.pr_id AS order_id,
        z.pr_status AS status, z.order_group,
        z.start_ts, z.end_ts, z.start_is_real, z.end_is_real,
        z.po_customer_name, z.pol_garment_class_description,
        z.pol_customer_style_id, z.pols_factory_style_id,
        CASE WHEN rs.pol_customer_style_id IS NOT NULL THEN 'recurrente' ELSE 'nuevo' END AS style_type,
        z.pol_unit_price, z.pol_requested_q
    FROM status AS z
    LEFT JOIN recurrent_styles AS rs ON rs.pol_customer_style_id = z.pol_customer_style_id
    UNION ALL
    SELECT
        p.process_id, '20104498044' AS owner_id,
        CONCAT('PO', p.po_id, '_', p.pol_id, '_', p.po_customer_id) AS order_id,
        'PO' AS status, p.order_group,
        NULL AS start_ts, NULL AS end_ts, 0 AS start_is_real, 0 AS end_is_real,
        p.po_customer_name, p.pol_garment_class_description,
        p.pol_customer_style_id, p.pols_factory_style_id,
        CASE WHEN rs.pol_customer_style_id IS NOT NULL THEN 'recurrente' ELSE 'nuevo' END AS style_type,
        p.pol_unit_price, p.pol_requested_q
    FROM pol_only_proc AS p
    LEFT JOIN recurrent_styles AS rs ON rs.pol_customer_style_id = p.pol_customer_style_id
)
SELECT process_id, owner_id, order_id, status, order_group,
    start_ts, end_ts, start_is_real, end_is_real,
    po_customer_name, pol_garment_class_description,
    pol_customer_style_id, pols_factory_style_id,
    style_type, pol_unit_price, pol_requested_q
FROM z1;
`;
