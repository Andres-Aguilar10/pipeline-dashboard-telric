WITH cfg AS (
    SELECT
        CAST('2025-01-27' AS timestamp) AS t_min,
        CAST('2026-01-27' AS timestamp) AS t_max
),
recurrent_styles AS (
    SELECT DISTINCT estilo_cliente AS pol_customer_style_id
    FROM silver.costo_wip_op
    WHERE version_calculo = 'FLUIDA'
      AND prendas_requeridas >= 200
      AND estilo_cliente IS NOT NULL
      AND TRIM(estilo_cliente) != ''
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